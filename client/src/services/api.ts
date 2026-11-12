import type {
  Usuario,
  EstacionTrabajo,
  RegistroAsistencia,
  ResumenDashboard,
  DatosTrabajadorEnVivo,
  AuditoriaFraudeFacial,
} from '../types';

// URL base del API:
//  - Navegador/PWA servida por el mismo backend: ruta relativa /api (sin problemas de CORS/HTTPS)
//  - App Capacitor (Android/iOS): VITE_API_BASE_URL (ej. https://asistencia.tuempresa.com)
const getApiBase = () => {
  const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envBase) return `${envBase.replace(/\/$/, '')}/api`;
  if (typeof window !== 'undefined' && !window.location.protocol.startsWith('capacitor')) {
    return '/api';
  }
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  return `http://${host}:3001/api`;
};

// ---------- Sesión ----------
// La app de trabajador (/) y la consola de administración (/admin) usan sesiones SEPARADAS:
// así una sesión de trabajador nunca se interpreta como sesión de administrador (ni al revés).
const LEGACY_TOKEN_KEY = 'smi_token';
const tokenKey = () =>
  typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
    ? 'smi_token_admin'
    : 'smi_token_worker';

export const auth = {
  getToken(): string | null {
    try {
      return localStorage.getItem(tokenKey());
    } catch {
      return null;
    }
  },
  setToken(token: string) {
    try {
      localStorage.setItem(tokenKey(), token);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      /* almacenamiento no disponible */
    }
  },
  clear() {
    try {
      localStorage.removeItem(tokenKey());
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      /* almacenamiento no disponible */
    }
  },
};

// Ticket de verificación facial (un solo uso): lo entrega el servidor tras reconocer el rostro
let bioTicket: string | null = null;

/** Petición autenticada. Si el servidor responde 401 se cierra la sesión local. */
async function request(path: string, init: RequestInit = {}, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth.getToken();
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* respuesta sin cuerpo JSON */
  }

  if (res.status === 401 && opts.auth !== false && token) {
    auth.clear();
    window.dispatchEvent(new Event('smi:unauthorized'));
  }
  if (!res.ok) {
    const err: any = new Error(data?.error || `Error del servidor (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // ----- Sesión -----
  async getPublicWorkers(): Promise<Array<Pick<Usuario, 'id' | 'codigo_empleado' | 'nombre' | 'cargo'>>> {
    return request('/public/workers', {}, { auth: false });
  },

  async login(usuarioId: number, pin: string): Promise<Usuario> {
    const data = await request('/auth/login', { method: 'POST', body: JSON.stringify({ usuarioId, pin }) }, { auth: false });
    auth.setToken(data.token);
    return data.user;
  },

  async adminLogin(codigo: string, clave: string): Promise<Usuario> {
    const data = await request('/auth/admin-login', { method: 'POST', body: JSON.stringify({ codigo, clave }) }, { auth: false });
    auth.setToken(data.token);
    return data.user;
  },

  async getMe(): Promise<Usuario> {
    return request('/auth/me');
  },

  logout() {
    auth.clear();
    bioTicket = null;
  },

  async getMyShift(): Promise<any | null> {
    return request('/me/shift');
  },

  // ----- Biometría facial (se compara en el servidor) -----
  async verifyFace(
    descriptor: number[],
    foto: string,
    tipo: 'entrada' | 'salida'
  ): Promise<{ isMatch: boolean; similarity: number }> {
    try {
      const data = await request('/biometric/verify', { method: 'POST', body: JSON.stringify({ descriptor, foto, tipo }) });
      bioTicket = data.isMatch ? data.ticket : null;
      return { isMatch: data.isMatch, similarity: data.similarity };
    } catch (err) {
      bioTicket = null;
      throw err;
    }
  },

  async enrolSelf(descriptor: number[], foto: string, tipo: 'entrada' | 'salida'): Promise<{ similarity: number }> {
    const data = await request('/biometric/enrol', { method: 'POST', body: JSON.stringify({ descriptor, foto, tipo }) });
    bioTicket = data.ticket;
    return { similarity: data.similarity };
  },

  // ----- Usuarios (administración) -----
  async getUsers(): Promise<Usuario[]> {
    return request('/users');
  },

  async createUser(data: {
    codigo_empleado: string;
    nombre: string;
    cargo?: string;
    correo?: string;
    telefono?: string;
    rol?: string;
    pin?: string;
  }): Promise<Usuario & { pinInicial?: string }> {
    return request('/users', { method: 'POST', body: JSON.stringify(data) });
  },

  async resetUserFace(usuarioId: number): Promise<{ exito: boolean; mensaje: string }> {
    return request(`/users/${usuarioId}/reset-face`, { method: 'POST' });
  },

  // ----- Estaciones de Trabajo -----
  async getWorkstations(): Promise<EstacionTrabajo[]> {
    return request('/workstations');
  },

  async createWorkstation(data: Partial<EstacionTrabajo>): Promise<EstacionTrabajo> {
    return request('/workstations', { method: 'POST', body: JSON.stringify(data) });
  },

  // Extraer coordenadas de un link de Google Maps
  async parseGoogleMapsUrl(url: string): Promise<{ latitud: number; longitud: number; nombreSugerido?: string; urlResuelta?: string }> {
    return request('/workstations/parse-maps-url', { method: 'POST', body: JSON.stringify({ url }) });
  },

  // ----- Resumen en Vivo -----
  async getLiveDashboard(): Promise<{ resumen: ResumenDashboard; trabajadores: DatosTrabajadorEnVivo[] }> {
    return request('/dashboard/live');
  },

  // Enrolamiento facial hecho por un administrador
  async enrolFace(usuarioId: number, descriptorFacial: number[], fotoReferencia: string) {
    return request(`/users/${usuarioId}/enrol-face`, {
      method: 'POST',
      body: JSON.stringify({ descriptorFacial, fotoReferencia }),
    });
  },

  // Registrar Entrada. El usuario sale de la sesión y la similitud del ticket firmado por el servidor;
  // los parámetros restantes se conservan solo por compatibilidad de firma.
  async checkIn(
    _usuarioId: number,
    latitud: number,
    longitud: number,
    precision?: number,
    fotoIngreso?: string,
    ..._legacy: unknown[]
  ) {
    const ticket = bioTicket;
    bioTicket = null;
    return request('/attendance/check-in', {
      method: 'POST',
      body: JSON.stringify({ latitud, longitud, precision, fotoIngreso, ticket }),
    });
  },

  // Registrar Salida
  async checkOut(
    _usuarioId: number,
    latitud?: number,
    longitud?: number,
    precision?: number,
    fotoSalida?: string,
    ..._legacy: unknown[]
  ) {
    const ticket = bioTicket;
    bioTicket = null;
    return request('/attendance/check-out', {
      method: 'POST',
      body: JSON.stringify({ latitud, longitud, precision, fotoSalida, ticket }),
    });
  },

  // Obtener Auditorías de Fraude
  async getFraudLogs(): Promise<AuditoriaFraudeFacial[]> {
    return request('/attendance/fraud-logs');
  },

  // Ping de Ubicación (solo turno activo)
  async sendLocationPing(_usuarioId: number, latitud: number, longitud: number, precision?: number) {
    return request('/location/ping', { method: 'POST', body: JSON.stringify({ latitud, longitud, precision }) });
  },

  // Historial de Asistencia
  async getAttendanceLogs(): Promise<RegistroAsistencia[]> {
    return request('/attendance/logs');
  },
};
