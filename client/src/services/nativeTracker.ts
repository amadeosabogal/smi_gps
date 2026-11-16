import { Capacitor, registerPlugin } from '@capacitor/core';
import { api, getApiOrigin } from './api';

// Puente con el servicio nativo de Android (rastreo del turno con la pantalla apagada o la app cerrada).
// En el navegador / PWA no existe: `esAppNativa` es false y no se usa nada de esto.

export interface PermisosNativos {
  ubicacionPrecisa: boolean;
  ubicacionAproximada: boolean;
  segundoPlano: boolean;
  notificaciones: boolean;
  bateriaSinRestriccion: boolean;
  ubicacionActivada: boolean;
}

export interface EstadoRastreo {
  activo: boolean;
  servicioCorriendo: boolean;
  pendientes: number;
  ultimoEnvio: number;
  ultimoPunto: number;
  tokenInvalido: boolean;
  ultimoError: string | null;
  fabricante: string;
  modelo: string;
  android: number;
  permisos: PermisosNativos;
  enviados?: number;
  error?: string | null;
}

interface SmiTrackerPlugin {
  permisosEstado(): Promise<PermisosNativos>;
  pedirUbicacion(): Promise<PermisosNativos>;
  pedirSegundoPlano(): Promise<PermisosNativos>;
  pedirNotificaciones(): Promise<PermisosNativos>;
  pedirBateriaSinRestriccion(): Promise<void>;
  abrirAjustes(): Promise<void>;
  abrirAjustesFabricante(): Promise<{ abierto: boolean }>;
  iniciar(o: { apiBase: string; token: string; intervaloMs?: number }): Promise<EstadoRastreo>;
  actualizarToken(o: { token: string }): Promise<EstadoRastreo>;
  enviarPendientes(): Promise<EstadoRastreo>;
  detener(): Promise<EstadoRastreo>;
  estado(): Promise<EstadoRastreo>;
  alertaAbierta(): Promise<{ id?: number; mensaje?: string }>;
}

export const esAppNativa = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const plugin = esAppNativa ? registerPlugin<SmiTrackerPlugin>('SmiTracker') : null;
const requerido = () => {
  if (!plugin) throw new Error('El rastreo en segundo plano solo existe en la app Android');
  return plugin;
};

// Fabricantes que cierran las apps en segundo plano con más agresividad: para ellos la excepción de batería es obligatoria
const FABRICANTES_AGRESIVOS = /xiaomi|redmi|poco|huawei|honor|oppo|realme|vivo|oneplus|tecno|infinix/i;
export const bateriaObligatoria = (fabricante: string) => FABRICANTES_AGRESIVOS.test(fabricante || '');

/** ¿Están concedidos todos los permisos que el rastreo con la pantalla apagada necesita? */
export const permisosCompletos = (est: EstadoRastreo): boolean => {
  const p = est.permisos;
  return (
    p.ubicacionPrecisa &&
    p.segundoPlano &&
    p.ubicacionActivada &&
    (est.android < 33 || p.notificaciones) &&
    (!bateriaObligatoria(est.fabricante) || p.bateriaSinRestriccion)
  );
};

/** Intervalo de captura del GPS (ms). Coincide con la frecuencia que ya usaba la versión web. */
const INTERVALO_MS = 15_000;

export const nativeTracker = {
  estado: () => requerido().estado(),
  permisos: () => requerido().permisosEstado(),
  pedirUbicacion: () => requerido().pedirUbicacion(),
  pedirSegundoPlano: () => requerido().pedirSegundoPlano(),
  pedirNotificaciones: () => requerido().pedirNotificaciones(),
  pedirBateria: () => requerido().pedirBateriaSinRestriccion(),
  abrirAjustes: () => requerido().abrirAjustes(),
  abrirAjustesFabricante: () => requerido().abrirAjustesFabricante(),
  /** Alerta del supervisor cuyo aviso tocó el trabajador (se entrega una sola vez). */
  alertaAbierta: () => requerido().alertaAbierta(),

  /**
   * Deja el rastreo corriendo para el turno activo. Se puede llamar las veces que haga falta:
   * si el servicio ya está activo y su token sirve, no hace nada.
   */
  async asegurarRastreo(): Promise<EstadoRastreo> {
    const p = requerido();
    const est = await p.estado();
    if (est.activo && est.servicioCorriendo && !est.tokenInvalido) return est;
    const { token } = await api.getTrackToken();
    if (est.activo && est.servicioCorriendo) return p.actualizarToken({ token });
    return p.iniciar({ apiBase: getApiOrigin(), token, intervaloMs: INTERVALO_MS });
  },

  /** Antes de marcar salida: envía lo que haya quedado en la cola (el turno cerrado ya no acepta puntos). */
  async enviarPendientes(): Promise<void> {
    try {
      await Promise.race([requerido().enviarPendientes(), new Promise((r) => setTimeout(r, 8000))]);
    } catch {
      /* si no hay red, la salida se registra igual */
    }
  },

  async detener(): Promise<void> {
    try {
      await requerido().detener();
    } catch {
      /* ya estaba detenido */
    }
  },
};
