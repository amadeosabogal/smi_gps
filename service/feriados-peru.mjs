// Feriados nacionales de Perú que la app propone como "día no laborable" (la app se bloquea en esas fechas
// salvo que el administrador la habilite desde la pestaña Calendario).
//
// IMPORTANTE: es una lista SUGERIDA. Cada año el Gobierno puede declarar días no laborables adicionales
// (o mover alguno), así que hay que contrastarla con el decreto oficial (El Peruano). El administrador puede
// corregir cualquier fecha desde el panel: habilitar un feriado, o bloquear un día extra.

// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher, calendario gregoriano)
export function domingoDePascua(anio) {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(anio, mes - 1, dia));
}

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const FIJOS = [
  ['01-01', 'Año Nuevo'],
  ['05-01', 'Día del Trabajo'],
  ['06-07', 'Batalla de Arica y Día de la Bandera'],
  ['06-29', 'San Pedro y San Pablo'],
  ['07-23', 'Día de la Fuerza Aérea del Perú'],
  ['07-28', 'Fiestas Patrias'],
  ['07-29', 'Fiestas Patrias'],
  ['08-06', 'Batalla de Junín'],
  ['08-30', 'Santa Rosa de Lima'],
  ['10-08', 'Combate de Angamos'],
  ['11-01', 'Día de Todos los Santos'],
  ['12-08', 'Inmaculada Concepción'],
  ['12-09', 'Batalla de Ayacucho'],
  ['12-25', 'Navidad'],
];

const cache = new Map(); // año -> Map(fecha -> nombre)

// Feriados sugeridos de un año: Map 'YYYY-MM-DD' -> nombre
export function feriadosDelAnio(anio) {
  if (cache.has(anio)) return cache.get(anio);
  const mapa = new Map();
  for (const [md, nombre] of FIJOS) mapa.set(`${anio}-${md}`, nombre);
  const pascua = domingoDePascua(anio).getTime();
  const DIA = 24 * 3600 * 1000;
  mapa.set(fmt(new Date(pascua - 3 * DIA)), 'Jueves Santo');
  mapa.set(fmt(new Date(pascua - 2 * DIA)), 'Viernes Santo');
  cache.set(anio, mapa);
  return mapa;
}

// Nombre del feriado sugerido para una fecha 'YYYY-MM-DD' (o null)
export function nombreFeriado(fecha) {
  const anio = Number(String(fecha).slice(0, 4));
  if (!Number.isInteger(anio)) return null;
  return feriadosDelAnio(anio).get(fecha) || null;
}
