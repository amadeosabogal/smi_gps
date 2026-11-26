import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { api, getApiOrigin } from './api';

// Puente con el rastreo nativo del turno (pantalla apagada o app en segundo plano): TrackerPlugin.java en Android
// y TrackerPlugin.swift en iPhone. En el navegador / PWA no existe: `esAppNativa` es false y no se usa nada de esto.

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
  abrirAjustesUbicacion(): Promise<void>;
  abrirAjustesFabricante(): Promise<{ abierto: boolean }>;
  iniciar(o: { apiBase: string; token: string; intervaloMs?: number }): Promise<EstadoRastreo>;
  actualizarToken(o: { token: string }): Promise<EstadoRastreo>;
  enviarPendientes(): Promise<EstadoRastreo>;
  detener(): Promise<EstadoRastreo>;
  estado(): Promise<EstadoRastreo>;
  alertaAbierta(): Promise<{ id?: number; mensaje?: string }>;
  abrirEnlace(o: { url: string }): Promise<void>;
  /** Solo iPhone: el trabajador tocó la notificación de una alerta. */
  addListener(evento: 'alertaTocada', accion: () => void): Promise<PluginListenerHandle>;
}

export const esAppAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export const esAppIOS = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
/** App instalada (Android o iPhone): tiene rastreo nativo. */
export const esAppNativa = esAppAndroid || esAppIOS;

const plugin = esAppNativa ? registerPlugin<SmiTrackerPlugin>('SmiTracker') : null;
const requerido = () => {
  if (!plugin) throw new Error('El rastreo en segundo plano solo existe en la aplicación instalada');
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
  /** Ajustes de ubicación del sistema: para volver a encender la ubicación del celular. */
  abrirAjustesUbicacion: () => requerido().abrirAjustesUbicacion(),
  abrirAjustesFabricante: () => requerido().abrirAjustesFabricante(),
  /** Versión instalada de la app (versionCode y nombre). */
  async versionInstalada(): Promise<{ code: number; nombre: string }> {
    const info = await CapApp.getInfo();
    return { code: Number.parseInt(info.build, 10) || 0, nombre: info.version };
  },
  /** Abre un enlace en el navegador del teléfono (descarga del APK nuevo). */
  abrirEnlace: (url: string) => requerido().abrirEnlace({ url }),
  /** Alerta del supervisor cuyo aviso tocó el trabajador (se entrega una sola vez). */
  alertaAbierta: () => requerido().alertaAbierta(),
  /** Avisa cuando se toca una alerta con la app ya abierta (iPhone). Devuelve cómo dejar de escuchar. */
  alTocarAlerta(accion: () => void): () => void {
    const escucha = requerido().addListener('alertaTocada', accion);
    return () => {
      escucha.then((e) => e.remove()).catch(() => {});
    };
  },

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
