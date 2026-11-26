// App del trabajador: estado de su solicitud de autorización a la oficina.
// Mientras está pendiente se consulta cada 10 s (y al volver a la app); cuando la oficina responde se avisa una vez.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { SolicitudMarcacion, TipoVerificacion } from '../types';

export const NOMBRE_MARCACION: Record<TipoVerificacion, string> = {
  entrada: 'entrada',
  salida: 'salida',
  almuerzo_inicio: 'inicio de almuerzo',
  almuerzo_fin: 'fin de almuerzo',
};

const CADA_MS = 10_000;
// Solicitud cuya respuesta todavía no se le ha mostrado (se recuerda aunque cierre la app)
const CLAVE = 'smi_autorizacion_en_espera';
const leerEnEspera = (): number => {
  try {
    return Number(localStorage.getItem(CLAVE) || 0);
  } catch {
    return 0;
  }
};
const guardarEnEspera = (id: number) => {
  try {
    if (id) localStorage.setItem(CLAVE, String(id));
    else localStorage.removeItem(CLAVE);
  } catch {
    /* almacenamiento no disponible */
  }
};

export const mensajeRespuesta = (s: SolicitudMarcacion): string | null => {
  const que = NOMBRE_MARCACION[s.tipo];
  const hora = new Date(s.creada_en).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (s.estado === 'aprobada') return `La oficina autorizó su ${que}.\nHora registrada: ${hora}`;
  if (s.estado === 'rechazada') return `La oficina no autorizó su ${que}.${s.motivo_rechazo ? ` Motivo: ${s.motivo_rechazo}` : ''}`;
  if (s.estado === 'vencida') return `Su solicitud de ${que} venció sin respuesta. Comuníquese con la oficina o intente de nuevo.`;
  return null; // anulada: marcó por la vía normal o canceló
};

export function useAutorizacion(activo: boolean, onRespuesta: (s: SolicitudMarcacion) => void) {
  const [habilitado, setHabilitado] = useState<boolean>(false);
  const [solicitud, setSolicitud] = useState<SolicitudMarcacion | null>(null);
  const avisar = useRef(onRespuesta);
  avisar.current = onRespuesta;

  const revisar = useCallback(async () => {
    try {
      const r = await api.getMiAutorizacion();
      setHabilitado(r.habilitado);
      const s = r.solicitud;
      setSolicitud(s && s.estado === 'pendiente' ? s : null);
      if (!s) return;
      if (s.estado === 'pendiente') guardarEnEspera(s.id);
      else if (leerEnEspera() === s.id) {
        guardarEnEspera(0);
        avisar.current(s);
      }
    } catch {
      /* sin conexión o servidor sin la función: se vuelve a intentar */
    }
  }, []);

  useEffect(() => {
    if (!activo) {
      setHabilitado(false);
      setSolicitud(null);
      return;
    }
    revisar();
    const alVolver = () => {
      if (document.visibilityState === 'visible') revisar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [activo, revisar]);

  const pendiente = Boolean(solicitud);
  useEffect(() => {
    if (!activo || !pendiente) return;
    const t = setInterval(revisar, CADA_MS);
    return () => clearInterval(t);
  }, [activo, pendiente, revisar]);

  const registrar = useCallback((s: SolicitudMarcacion) => {
    guardarEnEspera(s.id);
    setSolicitud(s);
  }, []);

  const cancelar = useCallback(async () => {
    if (!solicitud) return;
    guardarEnEspera(0);
    await api.cancelarAutorizacion(solicitud.id);
    setSolicitud(null);
    revisar();
  }, [solicitud, revisar]);

  return { habilitado, solicitud, registrar, cancelar, revisar };
}
