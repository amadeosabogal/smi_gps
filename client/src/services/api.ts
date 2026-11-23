import { getDeviceId } from './deviceId';
import type {
  Usuario,
  EstacionTrabajo,
  RegistroAsistencia,
  ResumenDashboard,
  DatosTrabajadorEnVivo,
  AuditoriaFraudeFacial,
  RecorridoTurno,
  TipoVerificacion,
  CalendarioRespuesta,
  EstadoDiaHoy,
  InfoPrivacidad,
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

/** Dirección base del servidor (sin /api). El servicio nativo de Android la usa para enviar la ubicación. */
export const getApiOrigin = (): string => {
  const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envBase) return envBase.replace(/\/$/, '');
  return typeof window !== 'undefined' ? window.location.origin : '';
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

// Caché de fotos ya descargadas (ruta -> URL local del navegador). Las fotos de asistencia no cambian nunca.
const photoCache = new Map<string, Promise<string>>();

// Ticket de verificación facial (un solo uso): lo entrega el servidor tras reconocer el rostro
let bioTicket: string | null = null;

/** Petición autenticada. Si el servidor responde 401 se cierra la sesión local. */
async function request(
  path: string,
  init: RequestInit = {},
  opts: { auth?: boolean; onHeaders?: (h: Headers) => void } = {}
) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  headers['X-Device-Id'] = getDeviceId(); // el turno queda atado al dispositivo que marcó la entrada
  const token = auth.getToken();
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });

  opts.onHeaders?.(res.headers);

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

  /** Ingreso del trabajador con su DNI y su contraseña (PIN) */
  async login(dni: string, pin: string): Promise<Usuario> {
    const data = await request('/auth/login', { method: 'POST', body: JSON.stringify({ dni, pin }) }, { auth: false });
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
    photoCache.forEach((p) => p.then((url) => URL.revokeObjectURL(url)).catch(() => {}));
    photoCache.clear();
  },

  /** Descarga una foto protegida (con la sesión) y devuelve una URL local lista para <img src>. */
  fetchPhoto(path: string): Promise<string> {
    let pending = photoCache.get(path);
    if (!pending) {
      pending = (async () => {
        const token = auth.getToken();
        const res = await fetch(`${getApiBase()}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (res.status === 401 && token) {
          auth.clear();
          window.dispatchEvent(new Event('smi:unauthorized'));
        }
        if (!res.ok) throw new Error('Foto no disponible');
        return URL.createObjectURL(await res.blob());
      })();
      photoCache.set(path, pending);
      pending.catch(() => photoCache.delete(path)); // reintentar la próxima vez si falló
    }
    return pending;
  },

  async getMyShift(): Promise<any | null> {
    return request('/me/shift');
  },

  // ----- Notificaciones / alertas -----
  async getPushConfig(): Promise<{ habilitado: boolean; publicKey: string | null }> {
    return request('/push/config');
  },

  async pushSubscribe(subscription: PushSubscriptionJSON, userAgent: string) {
    return request('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription, userAgent }) });
  },

  async pushUnsubscribe(endpoint: string) {
    return request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
  },

  /** Administrador/supervisor: envía una alerta al celular de un trabajador. */
  async sendAlert(usuarioId: number, mensaje: string): Promise<{
    alertaId: number;
    trabajador: string;
    dispositivos: number;
    entregadosAlServicioPush: number;
    caducados: number;
    appAbierta: boolean;
    appNativa?: boolean;
  }> {
    return request('/push/send', { method: 'POST', body: JSON.stringify({ usuarioId, mensaje }) });
  },

  /** Trabajador: marca la alerta como leída (se le avisa al administrador). */
  async ackAlert(alertaId: number) {
    return request(`/push/alertas/${alertaId}/leida`, { method: 'POST' });
  },

  // ----- Biometría facial (se compara en el servidor) -----
  async verifyFace(
    descriptor: number[],
    foto: string,
    tipo: TipoVerificacion
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

  /** Inicia el almuerzo (exige la verificación facial recién hecha). El GPS no se detiene. */
  async lunchStart(foto: string): Promise<{ exito: boolean; almuerzo: { id: number; permitidoMinutos: number } }> {
    const ticket = bioTicket;
    bioTicket = null;
    return request('/attendance/lunch/start', { method: 'POST', body: JSON.stringify({ foto, ticket }) });
  },

  /** Termina el almuerzo (exige la verificación facial recién hecha). */
  async lunchEnd(
    foto: string
  ): Promise<{ exito: boolean; almuerzo: { segundos: number; minutos: number; permitidoMinutos: number; excedido: boolean } }> {
    const ticket = bioTicket;
    bioTicket = null;
    return request('/attendance/lunch/end', { method: 'POST', body: JSON.stringify({ foto, ticket }) });
  },

  /** Un intento fallido de la prueba de vida (desde el 2.º seguido): queda en la auditoría de fraude con su foto. */
  async reportLivenessFail(foto: string, motivo: string, intentos: number): Promise<void> {
    await request('/biometric/liveness-fail', { method: 'POST', body: JSON.stringify({ foto, motivo, intentos }) });
  },

  async enrolSelf(descriptor: number[], foto: string, tipo: TipoVerificacion): Promise<{ similarity: number }> {
    const data = await request('/biometric/enrol', { method: 'POST', body: JSON.stringify({ descriptor, foto, tipo }) });
    bioTicket = data.ticket;
    return { similarity: data.similarity };
  },

  // ----- Usuarios (administración) -----
  async getUsers(): Promise<Usuario[]> {
    return request('/users');
  },

  async createUser(data: {
    codigo_empleado?: string; // con ingreso por DNI el código es el propio DNI
    dni?: string;
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

  // ----- Calendario de días no laborables -----
  /** Público: ¿hoy está bloqueada la app? (la pantalla de ingreso lo avisa) */
  async getCalendarioHoy(): Promise<EstadoDiaHoy> {
    return request('/calendar/hoy', {}, { auth: false });
  },

  async getCalendario(desde: string, hasta: string): Promise<CalendarioRespuesta> {
    return request(`/calendar?desde=${desde}&hasta=${hasta}`);
  },

  /** laborable: true habilita la app ese día, false la bloquea, null quita la decisión */
  async setDiaCalendario(fecha: string, laborable: boolean | null, motivo?: string): Promise<void> {
    await request(`/calendar/dias/${fecha}`, { method: 'PUT', body: JSON.stringify({ laborable, motivo }) });
  },

  async setDiasLibres(diasLibres: number[]): Promise<void> {
    await request('/calendar/config', { method: 'PUT', body: JSON.stringify({ diasLibres }) });
  },

  async autorizarTrabajadorDia(fecha: string, usuarioId: number, motivo?: string): Promise<void> {
    await request(`/calendar/dias/${fecha}/autorizados`, { method: 'POST', body: JSON.stringify({ usuarioId, motivo }) });
  },

  async quitarAutorizadoDia(fecha: string, usuarioId: number): Promise<void> {
    await request(`/calendar/dias/${fecha}/autorizados/${usuarioId}`, { method: 'DELETE' });
  },

  // ----- Gestión de datos del personal -----
  async updateUser(id: number, datos: { nombre?: string; cargo?: string; correo?: string; telefono?: string; dni?: string }): Promise<void> {
    await request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(datos) });
  },

  async resetUserPin(id: number): Promise<{ pinNuevo: string }> {
    return request(`/users/${id}/reset-pin`, { method: 'POST' });
  },

  /** Baja: desactiva y borra el rostro. Con eliminarDatos borra TODO (irreversible); `confirmar` = código de empleado. */
  async bajaUser(id: number, opts: { eliminarDatos?: boolean; confirmar?: string } = {}): Promise<{ eliminado: boolean }> {
    return request(`/users/${id}/baja`, { method: 'POST', body: JSON.stringify(opts) });
  },

  async reactivarUser(id: number): Promise<void> {
    await request(`/users/${id}/reactivar`, { method: 'POST' });
  },

  /** Descarga un archivo JSON con todos los datos del trabajador (derecho de acceso) */
  async downloadUserData(id: number, conFotos: boolean): Promise<void> {
    const token = auth.getToken();
    const res = await fetch(`${getApiBase()}/users/${id}/export${conFotos ? '?fotos=1' : ''}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let msg = `Error del servidor (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* sin cuerpo */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    a.href = url;
    a.download = m ? m[1] : `datos-${id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  // ----- Aviso de privacidad -----
  async getPrivacyInfo(): Promise<InfoPrivacidad> {
    return request('/privacy/info');
  },

  async acceptPrivacy(): Promise<void> {
    await request('/privacy/aceptar', { method: 'POST', body: JSON.stringify({ rostro: true, ubicacion: true, datos: true }) });
  },

  /** Elimina (da de baja) una estación. El historial conserva su nombre. */
  async deleteWorkstation(id: number): Promise<{ exito: boolean; id: number; nombre: string }> {
    return request(`/workstations/${id}`, { method: 'DELETE' });
  },

  // Extraer coordenadas de un link de Google Maps
  async parseGoogleMapsUrl(url: string): Promise<{ latitud: number; longitud: number; nombreSugerido?: string; urlResuelta?: string }> {
    return request('/workstations/parse-maps-url', { method: 'POST', body: JSON.stringify({ url }) });
  },

  // ----- Resumen en Vivo -----
  async getLiveDashboard(): Promise<{
    ahora?: string;
    almuerzoMinutos?: number;
    resumen: ResumenDashboard;
    trabajadores: DatosTrabajadorEnVivo[];
  }> {
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
    antiguedadMs?: number
  ) {
    const ticket = bioTicket;
    bioTicket = null;
    try {
      return await request('/attendance/check-in', {
        method: 'POST',
        body: JSON.stringify({ latitud, longitud, precision, fotoIngreso, ticket, antiguedadMs }),
      });
    } catch (err: any) {
      // Si fue por la ubicación, el servidor no consumió el ticket facial: se conserva para reintentar
      if (typeof err?.data?.codigo === 'string' && err.data.codigo.startsWith('GPS_')) bioTicket = ticket;
      throw err;
    }
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

  /** Administrador: cierra el turno de un trabajador sin verificación facial. El motivo queda en el historial. */
  async forceCheckout(asistenciaId: number, motivo: string): Promise<{ exito: boolean; trabajador: string }> {
    return request(`/attendance/${asistenciaId}/force-checkout`, { method: 'POST', body: JSON.stringify({ motivo }) });
  },

  /** Puntos GPS de un turno, en orden, para dibujar el recorrido (administración). */
  async getRoute(asistenciaId: number): Promise<RecorridoTurno> {
    return request(`/attendance/${asistenciaId}/route`);
  },

  // Obtener Auditorías de Fraude
  async getFraudLogs(): Promise<AuditoriaFraudeFacial[]> {
    return request('/attendance/fraud-logs');
  },

  // Ping de Ubicación (solo turno activo)
  async sendLocationPing(
    _usuarioId: number,
    latitud: number,
    longitud: number,
    precision?: number,
    antiguedadMs?: number
  ): Promise<any> {
    return request('/location/ping', { method: 'POST', body: JSON.stringify({ latitud, longitud, precision, antiguedadMs }) });
  },

  /** Token que usa el servicio nativo de Android para enviar la ubicación del turno activo con la app cerrada. */
  async getTrackToken(): Promise<{ token: string; asistenciaId: number; vigenciaHoras: number }> {
    return request('/location/track-token', { method: 'POST' });
  },

  /** Última versión publicada de la app Android (null si no hay ninguna). Es público: sirve también antes de iniciar sesión. */
  async getAppVersion(): Promise<{
    android: { versionCode: number; versionName: string; minVersionCode: number; url: string; notas: string } | null;
  }> {
    return request('/app/version', {}, { auth: false });
  },

  /** Precisión GPS que exige el servidor (metros) y antigüedad máxima de la lectura. */
  async getGpsConfig(): Promise<{ maxPrecisionCheckin: number; maxPrecisionPing: number; maxAgeMs: number }> {
    return request('/gps/config');
  },

  // Historial de Asistencia
  /** Historial paginado. desde/hasta son fecha-hora ISO ("hasta" excluyente); q busca por nombre o código. */
  async getAttendanceLogs(
    params: { desde?: string; hasta?: string; q?: string; limit?: number; offset?: number } = {}
  ): Promise<{ items: RegistroAsistencia[]; total: number }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    let total = 0;
    const items: RegistroAsistencia[] = await request(`/attendance/logs${qs.toString() ? `?${qs}` : ''}`, {}, {
      onHeaders: (h) => {
        total = Number(h.get('X-Total-Count') || 0);
      },
    });
    return { items, total: total || items.length };
  },
};
