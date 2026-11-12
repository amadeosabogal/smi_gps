import { api } from './api';

// Notificaciones push del celular (alertas del supervisor, incluso con la pantalla apagada).
// Requiere HTTPS, el service worker de la PWA y que el trabajador acepte el permiso.

export type PushState =
  | 'cargando'
  | 'no-disponible' // el servidor no tiene las notificaciones configuradas
  | 'no-soportado' // el navegador no admite push
  | 'ios-instalar' // iPhone/iPad: solo funciona con la app instalada en la pantalla de inicio
  | 'bloqueado' // el usuario denegó el permiso
  | 'inactivo' // todavía no activadas
  | 'activo';

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// La clave pública llega en base64 URL-safe y el navegador la quiere en bytes
function base64UrlToBytes(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'ios-instalar' : 'no-soportado';

  try {
    const cfg = await api.getPushConfig();
    if (!cfg.habilitado) return 'no-disponible';
  } catch {
    return 'no-disponible';
  }

  if (Notification.permission === 'denied') return 'bloqueado';
  if (Notification.permission !== 'granted') return 'inactivo';

  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'activo' : 'inactivo';
}

/** Pide el permiso (debe llamarse desde un toque del usuario), suscribe el celular y lo registra en el servidor. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return getPushState();

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'bloqueado' : 'inactivo';

  await subscribeAndRegister();
  return 'activo';
}

async function subscribeAndRegister() {
  const cfg = await api.getPushConfig();
  if (!cfg.habilitado || !cfg.publicKey) throw new Error('Las notificaciones no están disponibles en el servidor');

  const key = base64UrlToBytes(cfg.publicKey);
  const reg = await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  // Si la suscripción se hizo con otra clave del servidor (p. ej. se regeneraron), se rehace
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  }
  await api.pushSubscribe(sub.toJSON(), navigator.userAgent);
}

/** Tras iniciar sesión: si el permiso ya estaba concedido, vuelve a registrar el celular (sin preguntar nada). */
export async function syncPush(): Promise<void> {
  try {
    if (pushSupported() && Notification.permission === 'granted') await subscribeAndRegister();
  } catch (err) {
    console.warn('No se pudo sincronizar las notificaciones:', err);
  }
}

/** Al cerrar sesión: el servidor deja de enviar alertas de este trabajador a este celular. */
export async function releasePush(): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api.pushUnsubscribe(sub.endpoint);
  } catch {
    /* si no hay red o ya no hay sesión, no pasa nada */
  }
}
