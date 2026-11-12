import { io, Socket } from 'socket.io-client';
import { auth } from './api';

const getSocketUrl = () => {
  const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envBase) return envBase.replace(/\/$/, '');
  if (typeof window !== 'undefined' && !window.location.protocol.startsWith('capacitor')) {
    return window.location.origin;
  }
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  return `http://${host}:3001`;
};

// El socket exige una sesión válida: se conecta después de iniciar sesión (connectSocket)
export const socket: Socket = io(getSocketUrl(), {
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 1000,
  auth: (cb) => cb({ token: auth.getToken() }),
});

export function connectSocket() {
  if (auth.getToken() && !socket.connected) socket.connect();
}

export function disconnectSocket() {
  if (socket.connected || socket.active) socket.disconnect();
}

socket.on('connect', () => {
  console.log('⚡ Conectado al servidor de WebSockets');
});

socket.on('disconnect', () => {
  console.log('❌ Desconectado de WebSockets');
});

socket.on('connect_error', (err) => {
  console.warn('WebSocket rechazado:', err.message);
});
