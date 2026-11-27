// Pasos del asistente de permisos de la app instalada (Android e iPhone). Lógica pura (se prueba sin teléfono).
import type { EstadoRastreo } from './nativeTracker';

export type IdPaso = 'ubicacion' | 'precisa' | 'todo' | 'notificaciones' | 'bateria' | 'fabricante';

export interface PasoPermiso {
  id: IdPaso;
  /** Lo confirma el teléfono; el ajuste del fabricante no se puede comprobar */
  ok: boolean;
  obligatorio: boolean;
  /** 'ventana': el sistema muestra una ventana y la app la abre sola · 'ajustes': hay que ir a una pantalla de ajustes */
  modo: 'ventana' | 'ajustes';
}

export const esXiaomi = (fabricante: string) => /xiaomi|redmi|poco/i.test(fabricante || '');
export const esSamsung = (fabricante: string) => /samsung/i.test(fabricante || '');

/** Todos los pasos que aplican a este teléfono, en el orden en que el sistema permite concederlos. */
export function pasosDePermisos(est: EstadoRastreo, bateriaEsObligatoria: boolean, ios = false): PasoPermiso[] {
  const p = est.permisos;
  if (ios) {
    // iPhone pregunta "Siempre" con una ventana (una sola vez) y no permite exigir las notificaciones
    return [
      { id: 'ubicacion', ok: p.ubicacionActivada, obligatorio: true, modo: 'ajustes' },
      { id: 'precisa', ok: p.ubicacionPrecisa, obligatorio: true, modo: 'ventana' },
      { id: 'todo', ok: p.segundoPlano, obligatorio: true, modo: 'ventana' },
      { id: 'notificaciones', ok: p.notificaciones, obligatorio: false, modo: 'ventana' },
    ];
  }
  const pasos: PasoPermiso[] = [
    { id: 'ubicacion', ok: p.ubicacionActivada, obligatorio: true, modo: 'ajustes' },
    { id: 'precisa', ok: p.ubicacionPrecisa, obligatorio: true, modo: 'ventana' },
    // "Todo el tiempo" solo se puede pedir después de la ubicación precisa, y se elige en una pantalla de ajustes
    { id: 'todo', ok: p.segundoPlano, obligatorio: true, modo: 'ajustes' },
  ];
  if (est.android >= 33) pasos.push({ id: 'notificaciones', ok: p.notificaciones, obligatorio: true, modo: 'ventana' });
  pasos.push({ id: 'bateria', ok: p.bateriaSinRestriccion, obligatorio: bateriaEsObligatoria, modo: 'ventana' });
  if (esXiaomi(est.fabricante) || esSamsung(est.fabricante)) {
    pasos.push({ id: 'fabricante', ok: false, obligatorio: false, modo: 'ajustes' });
  }
  return pasos;
}

/**
 * Paso que toca ahora: el que el trabajador eligió (si sigue pendiente) o el primero pendiente.
 * `omitidos` solo vale para los opcionales. null = no queda nada por hacer.
 */
export function pasoActual(pasos: PasoPermiso[], omitidos: ReadonlySet<IdPaso>, elegido: IdPaso | null = null): PasoPermiso | null {
  const pendientes = pasos.filter((p) => !p.ok && (p.obligatorio || !omitidos.has(p.id)));
  const pedido = pendientes.find((p) => p.id === elegido);
  // "Todo el tiempo" no se puede saltar por delante de la ubicación precisa
  if (pedido && !(pedido.id === 'todo' && pendientes.some((p) => p.id === 'precisa'))) return pedido;
  return pendientes[0] ?? null;
}
