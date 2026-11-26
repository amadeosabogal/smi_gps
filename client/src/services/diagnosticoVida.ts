// Datos que acompañan a un fallo de la prueba de vida: sirven para saber qué regla lo rechazó y en qué teléfonos.
import type { DiagnosticoRetos } from './livenessChallenges';
import { esAppNativa, nativeTracker } from './nativeTracker';

export interface EquipoInfo {
  /** Versión de la app ("1.0.8(9)") o "web" */
  app: string;
  /** Marca, modelo y versión de Android; en la web, lo que informe el navegador */
  equipo: string;
}

export async function equipoActual(): Promise<EquipoInfo> {
  const web: EquipoInfo = {
    app: esAppNativa ? 'android' : 'web',
    equipo: typeof navigator === 'undefined' ? '' : (navigator.userAgent.match(/\(([^)]*)\)/)?.[1] ?? '').slice(0, 40),
  };
  if (!esAppNativa) return web;
  try {
    const [v, e] = await Promise.all([nativeTracker.versionInstalada(), nativeTracker.estado()]);
    return { app: `${v.nombre}(${v.code})`, equipo: `${e.fabricante} ${e.modelo} A${e.android}`.slice(0, 40) };
  } catch {
    return web;
  }
}

const dos = (n: number) => Math.round(n * 100) / 100;

export type DiagnosticoEnvio = Record<string, string | number>;

/** Versión compacta para el servidor: solo números y palabras cortas (se guarda junto a la alerta). */
export function diagnosticoParaEnviar(
  d: DiagnosticoRetos | null,
  extra: EquipoInfo & { fps: number; distancia?: number; continuidad?: boolean }
): DiagnosticoEnvio {
  const o: DiagnosticoEnvio = {};
  if (extra.continuidad) o.etapa = 'continuidad';
  else if (d) o.etapa = d.etapa;
  if (d?.gesto && !extra.continuidad) {
    o.gesto = d.gesto;
    o.paso = d.indice + 1;
  }
  if (d?.lectura) {
    o.ojos = dos(d.lectura.cerrado);
    o.giro = dos(d.lectura.giro);
    o.boca = dos(d.lectura.boca);
    o.sonrisa = dos(d.lectura.sonrisa);
  }
  if (d?.base) {
    o.baseGiro = dos(d.base.giro);
    o.baseBoca = dos(d.base.boca);
    o.baseSonrisa = dos(d.base.sonrisa);
  }
  if (d?.correccion && !extra.continuidad) o.corregir = d.correccion;
  if (d && d.maximo !== null) o.maximo = dos(d.maximo);
  if (typeof extra.distancia === 'number') o.distancia = dos(extra.distancia);
  if (extra.fps > 0) o.fps = extra.fps;
  if (extra.app) o.app = extra.app;
  if (extra.equipo) o.equipo = extra.equipo;
  return o;
}
