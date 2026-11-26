// Alertas de fraude: texto del diagnóstico de la prueba de vida y agrupación para el panel. Lógica pura, sin base.

const NUMEROS = ['paso', 'ojos', 'giro', 'boca', 'sonrisa', 'baseGiro', 'baseBoca', 'baseSonrisa', 'maximo', 'distancia', 'fps'];
// Orden en que se escribe: lo más útil primero (si no cabe en la columna, se recorta el final)
const ORDEN = ['etapa', 'gesto', 'paso', 'corregir', 'ojos', 'giro', 'boca', 'sonrisa', 'maximo', 'distancia', 'baseGiro', 'baseBoca', 'baseSonrisa', 'fps', 'app', 'equipo'];
const CORTO = { baseGiro: 'bg', baseBoca: 'bb', baseSonrisa: 'bs', corregir: 'falta' };

/** Convierte el diagnóstico que envía el celular en un texto corto y seguro ("etapa=reposo ojos=0.38 …"). */
export function textoDiagnostico(d) {
  if (!d || typeof d !== 'object') return '';
  const partes = [];
  for (const clave of ORDEN) {
    const v = d[clave];
    if (NUMEROS.includes(clave)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1000) continue;
      partes.push(`${CORTO[clave] || clave}=${Math.round(v * 100) / 100}`);
    } else if (typeof v === 'string') {
      const limpio = v.replace(/[^\w .()\-]/g, '').trim().slice(0, 40);
      if (limpio) partes.push(`${CORTO[clave] || clave}=${limpio}`);
    }
  }
  return partes.join(' ');
}

/** Texto completo de la alerta (la columna admite 255 caracteres). */
export function notaFalloVida(motivo, intentos, diagnostico) {
  const base = `Prueba de vida fallida (${motivo}); intentos fallidos seguidos: ${intentos}`;
  const extra = textoDiagnostico(diagnostico);
  return (extra ? `${base} | ${extra}` : base).slice(0, 255);
}

/** Día AAAA-MM-DD de una fecha en la zona horaria de la empresa. */
export function diaEn(fecha, zona) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(fecha));
}

/**
 * Junta las alertas de un mismo trabajador, día y tipo. No borra ni cambia nada: cada intento va dentro de su grupo.
 * `filas` debe venir de la más reciente a la más antigua; los grupos salen en ese mismo orden.
 */
export function agruparAlertas(filas, zona = 'America/Lima') {
  const grupos = new Map();
  for (const f of filas) {
    const dia = diaEn(f.fecha_intento, zona);
    const clave = `${f.usuario_id}|${dia}|${f.tipo_evento}`;
    let g = grupos.get(clave);
    if (!g) {
      g = {
        clave,
        usuario_id: f.usuario_id,
        nombre_usuario: f.nombre_usuario,
        codigo_empleado: f.codigo_empleado,
        tipo_evento: f.tipo_evento,
        dia,
        total: 0,
        primera: f.fecha_intento,
        ultima: f.fecha_intento,
        motivos: {},
        alertas: [],
      };
      grupos.set(clave, g);
    }
    g.total += 1;
    g.primera = f.fecha_intento; // vienen en orden descendente: la última vista es la más antigua
    if (f.tipo_evento === 'FALLA_PRUEBA_VIDA') {
      const motivo = /Prueba de vida fallida \(([a-z_]+)\)/i.exec(f.notas || '')?.[1] || 'desconocido';
      g.motivos[motivo] = (g.motivos[motivo] || 0) + 1;
    }
    g.alertas.push(f);
  }
  return [...grupos.values()];
}
