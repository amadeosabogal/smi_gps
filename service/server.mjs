import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import cors from 'cors';
import sql from 'mssql';
import * as webpush from 'web-push';

import { dbConfig, jwtSecret, config, isProduction } from './config.mjs';
import {
  hashPin,
  hashPinAsync,
  verifyPinAsync,
  signToken,
  verifyToken,
  createLimiter,
  euclideanDistance,
  similarityFromDistance,
  parseDescriptor,
} from './auth.mjs';
import { nombreFeriado } from './feriados-peru.mjs';
import { purgarVencidos, MINIMO_DIAS } from './retencion.mjs';
import { exportarDatos, darDeBaja, eliminarTodo } from './datos-trabajador.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROLES_ADMIN = ['administrador'];
const ROLES_STAFF = ['administrador', 'supervisor'];
const ROLES_WORKER = ['trabajador'];

const BIO_TICKET_TTL_SECONDS = 180;
const ALLOW_SELF_ENROL = process.env.ALLOW_SELF_ENROL !== 'false';

// ---------------------------------------------------------------------------
// App, HTTP(S) y Socket.IO
// ---------------------------------------------------------------------------
const app = express();
if (config.trustProxy) app.set('trust proxy', config.trustProxy === '1' ? 1 : config.trustProxy);
app.disable('x-powered-by');

const useTls = Boolean(config.sslKeyPath && config.sslCertPath);
const server = useTls
  ? https.createServer({ key: fs.readFileSync(config.sslKeyPath), cert: fs.readFileSync(config.sslCertPath) }, app)
  : http.createServer(app);

// CORS: con orígenes configurados solo esos; sin configurar, abierto solo en desarrollo
const corsOptions = config.corsOrigins.length ? { origin: config.corsOrigins } : isProduction ? null : { origin: true };

const io = new Server(server, {
  cors: corsOptions ? { origin: corsOptions.origin, methods: ['GET', 'POST'] } : undefined,
});

if (corsOptions) app.use(cors(corsOptions));

// Cabeceras de seguridad
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  if (isProduction && (req.secure || useTls)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------
let pool;
async function getPool() {
  if (!pool || !pool.connected) {
    try {
      if (pool) {
        try { await pool.close(); } catch {}
      }
      pool = await sql.connect(dbConfig);
      pool.on('error', (err) => {
        console.error('⚠️ Error en pool SQL Server:', err.message);
        pool = null;
      });
      console.log(`✅ Conexión establecida con base de datos ${dbConfig.database}`);
    } catch (err) {
      console.error('❌ Error conectando a SQL Server:', err.message);
      pool = null;
      throw err;
    }
  }
  return pool;
}

// ¿La columna pin ya admite hashes? (se corrige con: node service/migrate-security.mjs)
// Documento (DNI) del trabajador para el ingreso (se crea con: npm run migrate-dni). Sin la columna el ingreso es por nombre, como antes.
let dniColumna = false;
async function checkDniColumna() {
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT COL_LENGTH('Usuarios', 'dni') AS n");
    dniColumna = Boolean(r.recordset[0].n);
    if (!dniColumna) console.warn('⚠️ El ingreso con DNI aún no está habilitado: ejecuta  npm run migrate-dni  y reinicia.');
  } catch (err) {
    console.warn('No se pudo comprobar la columna dni:', err.message);
  }
}
// Proyectos que agrupan las estaciones (se crean con: npm run migrate-proyectos). Sin la migración todo sigue como antes.
let proyectosHabilitados = false;
async function checkProyectos() {
  try {
    const p = await getPool();
    const r = await p.request().query(
      "SELECT OBJECT_ID('Proyectos', 'U') AS t, COL_LENGTH('EstacionesTrabajo', 'proyecto_id') AS c"
    );
    proyectosHabilitados = Boolean(r.recordset[0].t && r.recordset[0].c);
    if (!proyectosHabilitados) console.warn('⚠️ Los proyectos de estaciones aún no están habilitados: ejecuta  npm run migrate-proyectos  y reinicia.');
  } catch (err) {
    console.warn('No se pudo comprobar la tabla Proyectos:', err.message);
  }
}
// DNI (8 dígitos) o carnet de extranjería/pasaporte (8 a 12 letras y números), sin espacios ni guiones
const normalizarDni = (v) => String(v ?? '').replace(/[\s.-]/g, '').toUpperCase();
const dniValido = (v) => /^[A-Z0-9]{8,12}$/.test(v);

let pinColumnWide = false;
async function checkPinColumn() {
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT COL_LENGTH('Usuarios', 'pin') AS bytes");
    const bytes = r.recordset[0].bytes;
    pinColumnWide = bytes === null || bytes >= 100;
    if (!pinColumnWide) {
      console.warn('⚠️ La columna Usuarios.pin es corta: ejecuta  node service/migrate-security.mjs  para poder guardar PIN hasheados.');
    }
  } catch (err) {
    console.warn('No se pudo comprobar la columna pin:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Notificaciones push (alertas al celular, incluso con la pantalla apagada)
// ---------------------------------------------------------------------------
const pushConfigurado = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
if (pushConfigurado) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
} else {
  console.warn('⚠️ Notificaciones push desactivadas: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (ejecuta: npm run vapid).');
}

// ¿Existen ya las tablas de push? (se crean con: npm run migrate-push)
let pushTablasListas = false;
async function checkPushTables() {
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT OBJECT_ID('SuscripcionesPush', 'U') AS a, OBJECT_ID('AlertasEnviadas', 'U') AS b");
    pushTablasListas = Boolean(r.recordset[0].a && r.recordset[0].b);
    if (pushConfigurado && !pushTablasListas) {
      console.warn('⚠️ Faltan las tablas de notificaciones: ejecuta  npm run migrate-push');
    }
  } catch (err) {
    console.warn('No se pudo comprobar las tablas de notificaciones:', err.message);
  }
}

// ¿Existe ya la columna dispositivo_id? (se crea con: npm run migrate-dispositivo). Sin ella todo funciona como antes.
let dispositivoColumna = false;
async function checkDispositivoColumna() {
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT COL_LENGTH('RegistroAsistencia', 'dispositivo_id') AS n");
    dispositivoColumna = Boolean(r.recordset[0].n);
    if (!dispositivoColumna) {
      console.warn('⚠️ Los turnos aún no se atan al dispositivo: ejecuta  npm run migrate-dispositivo  y reinicia.');
    }
  } catch (err) {
    console.warn('No se pudo comprobar la columna dispositivo_id:', err.message);
  }
}

// ¿Existen las columnas de batería? (se crean con: npm run migrate-bateria). Sin ellas todo funciona como antes.
let bateriaColumnas = false;
async function checkBateriaColumnas() {
  try {
    const p = await getPool();
    const r = await p.request().query(
      "SELECT COL_LENGTH('HistorialUbicaciones', 'bateria') AS h, COL_LENGTH('UbicacionesEnVivo', 'bateria') AS v"
    );
    bateriaColumnas = Boolean(r.recordset[0].h && r.recordset[0].v);
    if (!bateriaColumnas) console.warn('⚠️ La batería del celular aún no se guarda: ejecuta  npm run migrate-bateria  y reinicia.');
  } catch (err) {
    console.warn('No se pudo comprobar las columnas de batería:', err.message);
  }
}

// ¿Existe ya la tabla del almuerzo? (se crea con: npm run migrate-almuerzo). Sin ella el almuerzo no está habilitado.
let almuerzoTabla = false;
async function checkAlmuerzoTabla() {
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT OBJECT_ID('AlmuerzosTurno', 'U') AS id");
    almuerzoTabla = Boolean(r.recordset[0].id);
    if (!almuerzoTabla) console.warn('⚠️ El almuerzo aún no está habilitado: ejecuta  npm run migrate-almuerzo  y reinicia.');
  } catch (err) {
    console.warn('No se pudo comprobar la tabla del almuerzo:', err.message);
  }
}
function almuerzoNoDisponible(res) {
  if (almuerzoTabla) return false;
  res.status(503).json({ error: 'El almuerzo aún no está habilitado en el servidor. Avise al administrador.', codigo: 'ALMUERZO_NO_DISPONIBLE' });
  return true;
}

process.on('uncaughtException', (err) => {
  console.error('🚨 Excepción no capturada:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('🚨 Rechazo no manejado:', reason);
});

// Respuesta de error: en producción no se filtran detalles internos
function fail(res, err, status = 500) {
  console.error('Error en API:', err);
  res.status(status).json({ error: isProduction ? 'Error interno del servidor' : err.message });
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const aRadianes = (x) => (x * Math.PI) / 180;
  const dLat = aRadianes(lat2 - lat1);
  const dLon = aRadianes(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Las estaciones casi nunca cambian: se guardan 60 s en memoria para no consultarlas en cada punto GPS
let estacionesCache = null; // { t, data }
async function getEstacionesActivas() {
  if (estacionesCache && Date.now() - estacionesCache.t < 60_000) return estacionesCache.data;
  const p = await getPool();
  const res = await p.request().query('SELECT * FROM EstacionesTrabajo WHERE activo = 1');
  estacionesCache = { t: Date.now(), data: res.recordset };
  return estacionesCache.data;
}

async function detectarEstacionTrabajo(latitud, longitud) {
  const estaciones = await getEstacionesActivas();

  let estacionCercana = null;
  let distanciaMinima = Infinity;
  for (const estacion of estaciones) {
    const dist = calcularDistanciaMetros(latitud, longitud, estacion.latitud, estacion.longitud);
    if (dist < distanciaMinima) {
      distanciaMinima = dist;
      estacionCercana = estacion;
    }
  }

  const dentroDeEstacion = estacionCercana && distanciaMinima <= estacionCercana.radio_metros;
  return {
    estacion: estacionCercana,
    distanciaMetros: Math.round(distanciaMinima),
    dentroDeEstacion: Boolean(dentroDeEstacion),
    estacionId: dentroDeEstacion && estacionCercana ? estacionCercana.id : null,
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const validCoords = (lat, lng) => isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const optNum = (v) => (isNum(v) ? v : null);
const validPhoto = (s, maxChars = 4_000_000) =>
  typeof s === 'string' && s.length <= maxChars && /^data:image\/(jpeg|png|webp);base64,/.test(s);

// Quita las fotos (base64) de un registro antes de enviarlo por socket o responder al celular:
// pesan ~100 KB cada una y 30 marcas simultáneas multiplicarían ese tráfico por cada administrador conectado.
function sinFotos(registro) {
  if (!registro) return registro;
  const { foto_ingreso_url, foto_salida_url, ...resto } = registro;
  return { ...resto, tiene_foto_ingreso: Boolean(foto_ingreso_url), tiene_foto_salida: Boolean(foto_salida_url) };
}

// Entrega una foto guardada como data URL como imagen binaria (más liviana que base64 dentro de JSON)
function enviarFoto(res, dataUrl) {
  const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s) : null;
  if (!m) return res.status(404).json({ error: 'Foto no disponible' });
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.send(Buffer.from(m[2], 'base64'));
}

// ¿El error es por intentar crear un segundo turno activo? (índice único UX_RegistroAsistencia_turno_activo)
const esTurnoDuplicado = (err) => err && (err.number === 2601 || err.number === 2627);

// Último punto GPS aceptado por trabajador (en memoria): evita guardar decenas de miles de puntos casi idénticos
const PING_MIN_GAP_MS = 5_000;      // como mínimo 5 s entre puntos guardados...
const PING_MIN_MOVE_METERS = 10;    // ...salvo que se haya movido más de 10 m
const lastPings = new Map();        // usuarioId -> { t, lat, lng, geo }
const gpsImprecisos = new Map();    // usuarioId -> { t, precision } (último punto descartado por impreciso)
// Identificador del dispositivo: la app lo envía en la cabecera X-Device-Id (se genera una vez por instalación)
const dispositivoDe = (req) => {
  const v = req.headers['x-device-id'];
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
};
// Turno activo del trabajador y dispositivo al que está atado (null = sin atar: turnos de versiones anteriores).
// Se guarda 10 s en memoria para no consultar la base en cada punto GPS; check-in y check-out la invalidan.
const turnoCache = new Map(); // usuarioId -> { t, turno }
async function turnoActivoDe(p, usuarioId) {
  const c = turnoCache.get(usuarioId);
  if (c && Date.now() - c.t < 10_000) return c.turno;
  const r = await p.request().input('u', sql.Int, usuarioId).query(
    `SELECT id${dispositivoColumna ? ', dispositivo_id' : ''} FROM RegistroAsistencia WHERE usuario_id = @u AND estado = 'activo'`
  );
  const fila = r.recordset[0];
  const turno = fila ? { id: fila.id, dispositivo: fila.dispositivo_id || null } : null;
  turnoCache.set(usuarioId, { t: Date.now(), turno });
  return turno;
}
const esOtroDispositivo = (turno, dispositivo) => Boolean(turno && turno.dispositivo && turno.dispositivo !== dispositivo);
const MSG_OTRO_DISPOSITIVO =
  'Su turno está activo en otro dispositivo. Este teléfono no registra ubicación: para continuar aquí, registre su salida en el otro dispositivo y vuelva a marcar su entrada.';

const appNativaVista = new Map();   // usuarioId -> ms del último lote recibido de la app Android (sirve para saber si puede recibir alertas)
const appNativaActiva = (usuarioId, ventanaMs = 120_000) => Date.now() - (appNativaVista.get(usuarioId) || 0) < ventanaMs;

// Emitir solo a administradores/supervisores conectados
const emitStaff = (event, payload) => io.to('staff').emit(event, payload);

// ---------------------------------------------------------------------------
// Calendario laboral: días no laborables
//   Orden de decisión para una fecha: 1) lo que el administrador fijó para ese día · 2) días libres fijos de la
//   semana (p. ej. domingos) · 3) feriados de Perú precargados · 4) día laborable.
//   En un día no laborable la app se bloquea para los trabajadores, salvo los autorizados ese día y quien ya tiene un
//   turno activo (para que pueda terminarlo). Los intentos se rechazan y quedan en Alertas de fraude.
// ---------------------------------------------------------------------------
let calendarioTablas = false;
async function checkCalendarioTablas() {
  try {
    const p = await getPool();
    const r = await p.request().query(
      "SELECT OBJECT_ID('CalendarioDias', 'U') AS a, OBJECT_ID('CalendarioExcepciones', 'U') AS b, OBJECT_ID('CalendarioConfig', 'U') AS c"
    );
    const f = r.recordset[0];
    calendarioTablas = Boolean(f.a && f.b && f.c);
    if (!calendarioTablas) console.warn('⚠️ El calendario de días no laborables no está activo: ejecuta  npm run migrate-calendario  y reinicia.');
  } catch (err) {
    console.warn('No se pudo comprobar las tablas del calendario:', err.message);
  }
}

const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
// Fecha civil 'YYYY-MM-DD' en la zona horaria del negocio (no la de la VPS)
const fechaNegocio = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: config.zonaHoraria, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const fechaValida = (f) => {
  if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
};
const sumarDias = (f, n) => new Date(new Date(`${f}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const diaSemana = (f) => new Date(`${f}T00:00:00Z`).getUTCDay();

// Decisión pura para una fecha, dados lo fijado por el administrador (o null) y los días libres de la semana
function estadoSegun(fecha, override, diasLibres) {
  const feriado = nombreFeriado(fecha);
  const dow = diaSemana(fecha);
  if (override) {
    return { fecha, laborable: override.laborable, origen: 'admin', motivo: override.motivo || feriado || (diasLibres.has(dow) ? `Día libre (${NOMBRES_DIA[dow]})` : null), feriado };
  }
  if (diasLibres.has(dow)) {
    const libre = `día libre (${NOMBRES_DIA[dow]})`;
    return { fecha, laborable: false, origen: 'semanal', motivo: feriado ? `${feriado} · ${libre}` : `${libre.charAt(0).toUpperCase()}${libre.slice(1)}`, feriado };
  }
  if (feriado) return { fecha, laborable: false, origen: 'feriado', motivo: feriado, feriado };
  return { fecha, laborable: true, origen: 'normal', motivo: null, feriado: null };
}

// Caché corta: estas consultas se repiten en cada petición de un trabajador
const CAL_TTL_MS = 30_000;
const calCache = { libres: null, dias: new Map(), aut: new Map() };
const invalidarCalendario = () => { calCache.libres = null; calCache.dias.clear(); calCache.aut.clear(); };
async function cacheado(mapa, clave, cargar, vacio) {
  const c = mapa.get(clave);
  if (c && Date.now() - c.t < CAL_TTL_MS) return c.v;
  try {
    const v = await cargar();
    mapa.set(clave, { t: Date.now(), v });
    return v;
  } catch (err) {
    console.error('Calendario: no se pudo consultar la base de datos:', err.message);
    return c ? c.v : vacio; // si falla la BD se usa lo último conocido; sin datos, no se bloquea a nadie
  }
}
const parseDiasLibres = (txt) => new Set(String(txt || '').split(',').map((s) => s.trim()).filter((s) => /^[0-6]$/.test(s)).map(Number));
async function diasLibresSemana() {
  const c = calCache.libres;
  if (c && Date.now() - c.t < CAL_TTL_MS) return c.v;
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT valor FROM CalendarioConfig WHERE clave = 'dias_libres'");
    const v = parseDiasLibres(r.recordset[0]?.valor);
    calCache.libres = { t: Date.now(), v };
    return v;
  } catch (err) {
    console.error('Calendario: no se pudieron leer los días libres:', err.message);
    return c ? c.v : new Set();
  }
}
const overrideDe = (fecha) => cacheado(calCache.dias, fecha, async () => {
  const p = await getPool();
  const r = await p.request().input('f', sql.VarChar(10), fecha).query('SELECT laborable, motivo FROM CalendarioDias WHERE fecha = @f');
  const f = r.recordset[0];
  return f ? { laborable: Boolean(f.laborable), motivo: f.motivo || null } : null;
}, null);
const autorizadosDe = (fecha) => cacheado(calCache.aut, fecha, async () => {
  const p = await getPool();
  const r = await p.request().input('f', sql.VarChar(10), fecha).query('SELECT usuario_id FROM CalendarioExcepciones WHERE fecha = @f');
  return new Set(r.recordset.map((x) => x.usuario_id));
}, new Set());

async function estadoDelDia(fecha) {
  if (!calendarioTablas) return { fecha, laborable: true, origen: 'normal', motivo: null, feriado: null };
  return estadoSegun(fecha, await overrideDe(fecha), await diasLibresSemana());
}

// ¿Puede este trabajador usar la app hoy? (el turno activo se revisa aparte)
async function permisoHoy(usuarioId) {
  const fecha = fechaNegocio();
  const estado = await estadoDelDia(fecha);
  if (estado.laborable) return { permitido: true, estado };
  if ((await autorizadosDe(fecha)).has(usuarioId)) return { permitido: true, autorizado: true, estado };
  return { permitido: false, estado };
}

function mensajeDiaNoLaborable(estado) {
  const motivo = estado.motivo ? ` (${estado.motivo})` : '';
  return `Hoy ${estado.fecha.split('-').reverse().join('/')} es un día no laborable${motivo}. La aplicación está bloqueada. Si debe trabajar hoy, pida al administrador que lo autorice.`;
}

// Bloqueo para un trabajador: null si puede continuar. Quien ya tiene un turno activo puede terminarlo.
async function bloqueoDiaNoLaborable(usuarioId, via) {
  if (!calendarioTablas) return null;
  const permiso = await permisoHoy(usuarioId);
  if (permiso.permitido) return null;
  const turno = await turnoActivoDe(await getPool(), usuarioId);
  if (turno) return null;
  anotarIntentoDiaNoLaborable(usuarioId, permiso.estado, via);
  return {
    error: mensajeDiaNoLaborable(permiso.estado),
    codigo: 'DIA_NO_LABORABLE',
    fecha: permiso.estado.fecha,
    motivo: permiso.estado.motivo,
  };
}

// Queda anotado (Alertas de fraude), una vez cada 10 minutos por trabajador para no llenar la auditoría
const ultimoIntentoDia = new Map();
function anotarIntentoDiaNoLaborable(usuarioId, estado, via) {
  const clave = `${usuarioId}|${estado.fecha}`;
  if (Date.now() - (ultimoIntentoDia.get(clave) || 0) < 10 * 60 * 1000) return;
  ultimoIntentoDia.set(clave, Date.now());
  if (ultimoIntentoDia.size > 5000) ultimoIntentoDia.clear();
  registrarFraude({
    usuarioId,
    tipoEvento: 'INTENTO_DIA_NO_LABORABLE',
    foto: null,
    similitud: 0,
    notas: `Intentó usar la app en día no laborable (${estado.fecha}${estado.motivo ? ` · ${estado.motivo}` : ''}) · ${via}`.slice(0, 255),
  });
}

// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------
const loginIpLimiter = createLimiter({ max: config.loginIpMax, windowMs: 10 * 60 * 1000 });
const loginUserLimiter = createLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const faceFailLimiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

// ¿Sigue activo este trabajador? (una baja corta su acceso aunque su sesión no haya vencido). Caché corta.
const activoCache = new Map(); // usuarioId -> { t, v }
async function usuarioSigueActivo(usuarioId) {
  const c = activoCache.get(usuarioId);
  if (c && Date.now() - c.t < 15_000) return c.v;
  const p = await getPool();
  const r = await p.request().input('id', sql.Int, usuarioId).query('SELECT activo FROM Usuarios WHERE id = @id');
  const v = r.recordset.length > 0 && Boolean(r.recordset[0].activo);
  activoCache.set(usuarioId, { t: Date.now(), v });
  return v;
}

// Aviso de privacidad: ¿ya aceptó la versión vigente? (tabla creada con: npm run migrate-privacidad)
let privacidadTabla = false;
async function checkPrivacidadTabla() {
  try {
    const p = await getPool();
    const r = await p.request().query("SELECT OBJECT_ID('AceptacionesPrivacidad', 'U') AS id");
    privacidadTabla = Boolean(r.recordset[0].id);
    if (config.exigirAceptacionPrivacidad && !privacidadTabla) {
      console.warn('⚠️ EXIGIR_ACEPTACION_PRIVACIDAD está activo pero falta la tabla: ejecuta  npm run migrate-privacidad  y reinicia.');
    }
  } catch (err) {
    console.warn('No se pudo comprobar la tabla de aceptaciones del aviso de privacidad:', err.message);
  }
}
const aceptoCache = new Map(); // usuarioId -> { t, v }
async function aceptoPrivacidad(usuarioId) {
  const c = aceptoCache.get(usuarioId);
  if (c && Date.now() - c.t < 60_000) return c.v;
  const p = await getPool();
  const r = await p.request().input('u', sql.Int, usuarioId).input('v', sql.Int, config.privacidadVersion)
    .query('SELECT 1 AS ok FROM AceptacionesPrivacidad WHERE usuario_id = @u AND version = @v');
  const v = r.recordset.length > 0;
  aceptoCache.set(usuarioId, { t: Date.now(), v });
  return v;
}
// Bloqueo si el aviso es obligatorio y todavía no lo aceptó (quien ya tiene un turno activo puede terminarlo)
async function bloqueoAceptacion(usuarioId) {
  if (!config.exigirAceptacionPrivacidad || !privacidadTabla) return null;
  if (await aceptoPrivacidad(usuarioId)) return null;
  if (await turnoActivoDe(await getPool(), usuarioId)) return null;
  return {
    error: 'Debe leer y aceptar el aviso de privacidad para usar la aplicación. Abra la aplicación para aceptarlo (si no lo ve, actualice la app).',
    codigo: 'ACEPTACION_REQUERIDA',
  };
}

function requireAuth(roles, opts = {}) {
  // Las rutas de trabajador (roles = ROLES_WORKER) también se bloquean en un día no laborable
  const esRutaDeTrabajador = Boolean(roles && roles.includes('trabajador'));
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyToken(token, jwtSecret);
    if (!payload || payload.typ !== 'session') {
      return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión de nuevo.' });
    }
    if (roles && !roles.includes(payload.rol)) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    }
    req.user = { id: payload.sub, rol: payload.rol };
    if (esRutaDeTrabajador) {
      try {
        if (!(await usuarioSigueActivo(payload.sub))) {
          return res.status(401).json({ error: 'Su cuenta fue dada de baja. Comuníquese con la empresa.', codigo: 'CUENTA_DE_BAJA' });
        }
      } catch (err) {
        console.error('No se pudo comprobar si la cuenta sigue activa (se deja pasar):', err.message);
      }
      if (calendarioTablas) {
        try {
          const bloqueo = await bloqueoDiaNoLaborable(payload.sub, 'sesión abierta');
          if (bloqueo) return res.status(403).json(bloqueo);
        } catch (err) {
          console.error('Calendario: no se pudo comprobar el día (se deja pasar):', err.message);
        }
      }
      if (!opts.omitirAceptacion) {
        try {
          const bloqueo = await bloqueoAceptacion(payload.sub);
          if (bloqueo) return res.status(403).json(bloqueo);
        } catch (err) {
          console.error('No se pudo comprobar la aceptación del aviso (se deja pasar):', err.message);
        }
      }
    }
    next();
  };
}

// Token de rastreo: lo guarda el servicio nativo de Android para enviar ubicaciones aunque la app esté
// cerrada o la pantalla apagada. Solo sirve para /api/location/batch y está atado a UN turno activo.
function requireTrackAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token, jwtSecret);
  if (!payload || payload.typ !== 'track' || !Number.isInteger(payload.sub) || !Number.isInteger(payload.aid)) {
    return res.status(401).json({ error: 'Token de rastreo inválido o expirado.', codigo: 'TOKEN_INVALIDO' });
  }
  req.user = { id: payload.sub, rol: 'trabajador' };
  req.trackAsistenciaId = payload.aid;
  req.trackDispositivo = typeof payload.did === 'string' && payload.did ? payload.did : null;
  next();
}

// Tickets de verificación facial de un solo uso
const usedTickets = new Map(); // jti -> exp (segundos)
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of usedTickets) if (exp < now) usedTickets.delete(jti);
}, 60 * 1000).unref();

function consumeBioTicket(ticket, userId, tipo) {
  const payload = verifyToken(ticket, jwtSecret);
  if (!payload || payload.typ !== 'bio' || payload.sub !== userId || payload.tipo !== tipo) return null;
  if (usedTickets.has(payload.jti)) return null;
  usedTickets.set(payload.jti, payload.exp);
  return payload;
}

const issueBioTicket = (userId, tipo, similarity) =>
  signToken({ typ: 'bio', sub: userId, tipo, sim: similarity, jti: crypto.randomUUID() }, BIO_TICKET_TTL_SECONDS, jwtSecret);

const publicUser = (u) => ({
  id: u.id,
  codigo_empleado: u.codigo_empleado,
  nombre: u.nombre,
  correo: u.correo,
  cargo: u.cargo,
  rol: u.rol,
  facial_enrolado: Boolean(u.facial_enrolado),
});

// Falsa verificación para igualar tiempos cuando el usuario no existe
const DUMMY_HASH = hashPin('no-existe');

async function doLogin(req, res, { findUser, allowedRoles, ttlHours, secretValue, label, bloqueo }) {
  const ipKey = `ip:${req.ip}`;
  const blocked = loginIpLimiter.blockedFor(ipKey);
  if (blocked) {
    return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(blocked / 60)} min.` });
  }

  const user = await findUser();
  const userKey = `user:${user ? user.id : label}`;
  const userBlocked = user ? loginUserLimiter.blockedFor(userKey) : 0;
  if (userBlocked) {
    return res.status(429).json({ error: `Cuenta bloqueada temporalmente. Intenta en ${Math.ceil(userBlocked / 60)} min.` });
  }

  const secretOk = typeof secretValue === 'string' && secretValue.length > 0 && secretValue.length <= 100;
  // Siempre se calcula el hash (aunque el usuario no exista) para igualar tiempos de respuesta
  const pinOk = secretOk ? await verifyPinAsync(secretValue, user?.pin || DUMMY_HASH) : false;
  const ok = pinOk && Boolean(user?.pin) && user.activo && allowedRoles.includes(user.rol);

  if (!ok) {
    loginIpLimiter.fail(ipKey);
    if (user) loginUserLimiter.fail(userKey);
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  loginIpLimiter.reset(ipKey);
  loginUserLimiter.reset(userKey);
  if (bloqueo) {
    // PIN correcto, pero hoy no se puede entrar (día no laborable). Se rechaza y queda anotado.
    let motivoBloqueo = null;
    try { motivoBloqueo = await bloqueo(user); } catch (err) { console.error('Calendario: no se pudo comprobar el día (se deja pasar):', err.message); }
    if (motivoBloqueo) return res.status(403).json(motivoBloqueo);
  }
  const token = signToken({ typ: 'session', sub: user.id, rol: user.rol }, ttlHours * 3600, jwtSecret);
  return res.json({ token, user: publicUser(user) });
}

// ----------------- RUTAS PÚBLICAS -----------------

app.get('/api/health', (req, res) => {
  res.json({ estado: 'ok', fecha: new Date().toISOString() });
});

// Última versión de las apps (Android e iPhone). Se lee de version.json (junto al APK), así publicar una
// versión nueva no requiere reiniciar el servidor. Es público: solo contiene el número de versión y el enlace.
let versionAppCache = null; // { t, data }
function validarVersion(j, enlaceValido) {
  const url = typeof j?.url === 'string' ? j.url.trim() : '';
  if (!Number.isInteger(j?.versionCode) || j.versionCode <= 0 || !enlaceValido.test(url) || url.length > 300) return null;
  return {
    versionCode: j.versionCode,
    versionName: typeof j.versionName === 'string' ? j.versionName.slice(0, 20) : String(j.versionCode),
    minVersionCode: Number.isInteger(j.minVersionCode) && j.minVersionCode > 0 ? j.minVersionCode : 0,
    url,
    notas: typeof j.notas === 'string' ? j.notas.slice(0, 200) : '',
  };
}
// Un solo archivo por instalación: los datos de Android van en la raíz y los de iPhone dentro de "ios"
function leerVersionesApp() {
  if (versionAppCache && Date.now() - versionAppCache.t < 30_000) return versionAppCache.data;
  let data = { android: null, ios: null };
  try {
    const j = JSON.parse(fs.readFileSync(config.androidVersionFile, 'utf8'));
    data = {
      android: validarVersion(j, /^https?:\/\//),
      ios: validarVersion(j.ios, /^https:\/\//), // App Store o TestFlight
    };
  } catch {
    /* sin archivo o con formato inválido: no se avisa de nada */
  }
  versionAppCache = { t: Date.now(), data };
  return data;
}
app.get('/api/app/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(leerVersionesApp());
});

// Lista mínima para la pantalla de ingreso del trabajador (sin datos sensibles)
app.get('/api/public/workers', async (req, res) => {
  try {
    if (config.loginSoloDni) return res.json([]); // el ingreso es solo con DNI: no se publica ningún nombre
    const p = await getPool();
    const r = await p.request().query(
      "SELECT id, codigo_empleado, nombre, cargo FROM Usuarios WHERE rol = 'trabajador' AND activo = 1 ORDER BY nombre ASC"
    );
    res.json(r.recordset);
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { usuarioId, dni, pin } = req.body || {};
    const id = Number.parseInt(usuarioId, 10);
    const documento = normalizarDni(dni);
    await doLogin(req, res, {
      label: 'worker',
      secretValue: typeof pin === 'string' ? pin : String(pin ?? ''),
      allowedRoles: ROLES_WORKER,
      ttlHours: config.sessionHours,
      bloqueo: (user) => bloqueoDiaNoLaborable(user.id, 'inicio de sesión'),
      findUser: async () => {
        const p = await getPool();
        // Ingreso con DNI y contraseña
        if (dni !== undefined && dni !== null && dni !== '') {
          if (!dniColumna || !dniValido(documento)) return null;
          const r = await p.request().input('dni', sql.VarChar(12), documento).query('SELECT * FROM Usuarios WHERE dni = @dni');
          return r.recordset[0] || null;
        }
        // Ingreso antiguo por nombre (app anterior): solo mientras no se exija el DNI
        if (config.loginSoloDni || !Number.isInteger(id)) return null;
        const r = await p.request().input('id', sql.Int, id).query('SELECT * FROM Usuarios WHERE id = @id');
        return r.recordset[0] || null;
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { codigo, clave } = req.body || {};
    await doLogin(req, res, {
      label: `admin:${String(codigo || '').slice(0, 50)}`,
      secretValue: typeof clave === 'string' ? clave : '',
      allowedRoles: ROLES_STAFF,
      ttlHours: config.adminSessionHours,
      findUser: async () => {
        if (typeof codigo !== 'string' || !codigo || codigo.length > 50) return null;
        const p = await getPool();
        const r = await p.request().input('codigo', sql.VarChar(50), codigo.trim()).query('SELECT * FROM Usuarios WHERE codigo_empleado = @codigo');
        return r.recordset[0] || null;
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- CALENDARIO DE DÍAS NO LABORABLES -----------------

// Público: la pantalla de ingreso avisa si hoy la app está bloqueada (no revela nada sensible)
app.get('/api/calendar/hoy', async (req, res) => {
  try {
    const estado = await estadoDelDia(fechaNegocio());
    res.json({ fecha: estado.fecha, laborable: estado.laborable, motivo: estado.laborable ? null : estado.motivo });
  } catch (err) {
    fail(res, err);
  }
});

// Panel: calendario de un rango de fechas (máx. 400 días) con lo que decidió el administrador y los autorizados
app.get('/api/calendar', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const hoy = fechaNegocio();
    const desde = fechaValida(req.query.desde) ? req.query.desde : `${hoy.slice(0, 8)}01`;
    const hasta = fechaValida(req.query.hasta) ? req.query.hasta : sumarDias(desde, 90);
    const dias = Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
    if (dias < 1 || dias > 400) return res.status(400).json({ error: 'El rango debe ser de 1 a 400 días.' });
    if (!calendarioTablas) {
      return res.status(503).json({ error: 'El calendario aún no está activo en el servidor: ejecute  npm run migrate-calendario  y reinicie.', codigo: 'CALENDARIO_NO_DISPONIBLE' });
    }
    const p = await getPool();
    const [ovR, autR, cfgR] = await Promise.all([
      p.request().input('d', sql.VarChar(10), desde).input('h', sql.VarChar(10), hasta)
        .query("SELECT CONVERT(VARCHAR(10), fecha, 23) AS fecha, laborable, motivo FROM CalendarioDias WHERE fecha BETWEEN @d AND @h"),
      p.request().input('d', sql.VarChar(10), desde).input('h', sql.VarChar(10), hasta).query(`
        SELECT CONVERT(VARCHAR(10), e.fecha, 23) AS fecha, e.usuario_id, e.motivo, u.nombre, u.codigo_empleado
        FROM CalendarioExcepciones e JOIN Usuarios u ON u.id = e.usuario_id
        WHERE e.fecha BETWEEN @d AND @h ORDER BY u.nombre`),
      p.request().query("SELECT valor FROM CalendarioConfig WHERE clave = 'dias_libres'"),
    ]);
    const libres = parseDiasLibres(cfgR.recordset[0]?.valor);
    const overrides = new Map(ovR.recordset.map((o) => [o.fecha, { laborable: Boolean(o.laborable), motivo: o.motivo || null }]));
    const autorizados = new Map();
    for (const a of autR.recordset) {
      if (!autorizados.has(a.fecha)) autorizados.set(a.fecha, []);
      autorizados.get(a.fecha).push({ usuarioId: a.usuario_id, nombre: a.nombre, codigo: a.codigo_empleado, motivo: a.motivo || null });
    }
    const lista = [];
    for (let i = 0; i < dias; i++) {
      const fecha = sumarDias(desde, i);
      const ov = overrides.get(fecha) || null;
      const e = estadoSegun(fecha, ov, libres);
      lista.push({
        fecha,
        laborable: e.laborable,
        origen: e.origen,           // 'admin' | 'semanal' | 'feriado' | 'normal'
        motivo: e.motivo,
        feriado: e.feriado,         // nombre del feriado sugerido, si lo hay
        decision: ov ? ov.laborable : null, // lo fijado por el administrador (null = nada fijado)
        autorizados: autorizados.get(fecha) || [],
      });
    }
    res.json({ hoy, zonaHoraria: config.zonaHoraria, diasLibres: [...libres].sort(), dias: lista });
  } catch (err) {
    fail(res, err);
  }
});

function calendarioListo(res) {
  if (calendarioTablas) return true;
  res.status(503).json({ error: 'El calendario aún no está activo en el servidor: ejecute  npm run migrate-calendario  y reinicie.', codigo: 'CALENDARIO_NO_DISPONIBLE' });
  return false;
}
const motivoLimpio = (m) => (typeof m === 'string' && m.trim() ? m.trim().slice(0, 120) : null);

// Fija lo que pasa en una fecha: laborable=true habilita la app, false la bloquea, null quita la decisión
app.put('/api/calendar/dias/:fecha', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!calendarioListo(res)) return;
    const { fecha } = req.params;
    if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida (use AAAA-MM-DD).' });
    if (fecha < fechaNegocio()) return res.status(400).json({ error: 'No se puede cambiar un día que ya pasó.' });
    const { laborable } = req.body || {};
    if (laborable !== true && laborable !== false && laborable !== null) return res.status(400).json({ error: 'Indique laborable: true, false o null.' });
    const p = await getPool();
    if (laborable === null) {
      await p.request().input('f', sql.VarChar(10), fecha).query('DELETE FROM CalendarioDias WHERE fecha = @f');
    } else {
      await p.request()
        .input('f', sql.VarChar(10), fecha).input('l', sql.Bit, laborable ? 1 : 0)
        .input('m', sql.NVarChar(120), motivoLimpio(req.body.motivo)).input('by', sql.Int, req.user.id)
        .query(`
          UPDATE CalendarioDias SET laborable = @l, motivo = @m, creado_por = @by, creado_en = GETDATE() WHERE fecha = @f;
          IF @@ROWCOUNT = 0 INSERT INTO CalendarioDias (fecha, laborable, motivo, creado_por) VALUES (@f, @l, @m, @by);
        `);
    }
    invalidarCalendario();
    console.log(`📅 Admin ${req.user.id} fijó ${fecha}: ${laborable === null ? 'sin decisión (vuelve a la regla)' : laborable ? 'app HABILITADA' : 'app BLOQUEADA'}`);
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// Días libres fijos de la semana (0 = domingo … 6 = sábado)
app.put('/api/calendar/config', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!calendarioListo(res)) return;
    const { diasLibres } = req.body || {};
    if (!Array.isArray(diasLibres) || !diasLibres.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      return res.status(400).json({ error: 'diasLibres debe ser una lista de números del 0 (domingo) al 6 (sábado).' });
    }
    const valor = [...new Set(diasLibres)].sort().join(',');
    const p = await getPool();
    await p.request().input('v', sql.NVarChar(200), valor).query(`
      UPDATE CalendarioConfig SET valor = @v WHERE clave = 'dias_libres';
      IF @@ROWCOUNT = 0 INSERT INTO CalendarioConfig (clave, valor) VALUES ('dias_libres', @v);
    `);
    invalidarCalendario();
    console.log(`📅 Admin ${req.user.id} fijó los días libres semanales: [${valor}]`);
    res.json({ exito: true, diasLibres: valor ? valor.split(',').map(Number) : [] });
  } catch (err) {
    fail(res, err);
  }
});

// Autoriza a un trabajador a usar la app en una fecha no laborable
app.post('/api/calendar/dias/:fecha/autorizados', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!calendarioListo(res)) return;
    const { fecha } = req.params;
    const usuarioId = Number.parseInt(req.body?.usuarioId, 10);
    if (!fechaValida(fecha) || !Number.isInteger(usuarioId)) return res.status(400).json({ error: 'Solicitud inválida' });
    if (fecha < fechaNegocio()) return res.status(400).json({ error: 'No se puede autorizar un día que ya pasó.' });
    const p = await getPool();
    const u = await p.request().input('id', sql.Int, usuarioId).query("SELECT id FROM Usuarios WHERE id = @id AND rol = 'trabajador' AND activo = 1");
    if (!u.recordset.length) return res.status(404).json({ error: 'Trabajador no encontrado' });
    await p.request()
      .input('f', sql.VarChar(10), fecha).input('u', sql.Int, usuarioId)
      .input('m', sql.NVarChar(120), motivoLimpio(req.body.motivo)).input('by', sql.Int, req.user.id)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM CalendarioExcepciones WHERE fecha = @f AND usuario_id = @u)
          INSERT INTO CalendarioExcepciones (fecha, usuario_id, motivo, creado_por) VALUES (@f, @u, @m, @by);
      `);
    invalidarCalendario();
    console.log(`📅 Admin ${req.user.id} autorizó al trabajador ${usuarioId} el ${fecha}`);
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

app.delete('/api/calendar/dias/:fecha/autorizados/:usuarioId', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!calendarioListo(res)) return;
    const usuarioId = Number.parseInt(req.params.usuarioId, 10);
    if (!fechaValida(req.params.fecha) || !Number.isInteger(usuarioId)) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    await p.request().input('f', sql.VarChar(10), req.params.fecha).input('u', sql.Int, usuarioId)
      .query('DELETE FROM CalendarioExcepciones WHERE fecha = @f AND usuario_id = @u');
    invalidarCalendario();
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// ----- AVISO DE PRIVACIDAD (aceptación dentro de la app) -----

// Datos para mostrar el aviso al trabajador: empresa, plazos y si ya lo aceptó
app.get('/api/privacy/info', requireAuth(), async (req, res) => {
  try {
    const aceptada = privacidadTabla && req.user.rol === 'trabajador' ? await aceptoPrivacidad(req.user.id) : true;
    res.json({
      version: config.privacidadVersion,
      exigida: config.exigirAceptacionPrivacidad && privacidadTabla,
      aceptada,
      empresa: config.empresa,
      plazos: {
        gpsDias: retencionDias >= 7 ? retencionDias : 0,
        fotosDias: config.retencionFotosDias >= MINIMO_DIAS ? config.retencionFotosDias : 0,
        registrosDias: config.retencionRegistrosDias >= MINIMO_DIAS ? config.retencionRegistrosDias : 0,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// El trabajador acepta el aviso: debe otorgar las tres autorizaciones (sin ellas la app no puede registrar su asistencia)
app.post('/api/privacy/aceptar', requireAuth(ROLES_WORKER, { omitirAceptacion: true }), async (req, res) => {
  try {
    if (!privacidadTabla) {
      return res.status(503).json({ error: 'La aceptación del aviso aún no está habilitada en el servidor. Avise al administrador.', codigo: 'PRIVACIDAD_NO_DISPONIBLE' });
    }
    const { rostro, ubicacion, datos } = req.body || {};
    if (rostro !== true || ubicacion !== true || datos !== true) {
      return res.status(400).json({ error: 'Para usar la aplicación debe otorgar las tres autorizaciones.', codigo: 'AUTORIZACIONES_INCOMPLETAS' });
    }
    const dispositivo = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'].slice(0, 80) : null;
    const p = await getPool();
    await p.request()
      .input('u', sql.Int, req.user.id).input('v', sql.Int, config.privacidadVersion).input('d', sql.VarChar(80), dispositivo)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM AceptacionesPrivacidad WHERE usuario_id = @u AND version = @v)
          INSERT INTO AceptacionesPrivacidad (usuario_id, version, autoriza_rostro, autoriza_ubicacion, autoriza_datos, dispositivo_id)
          VALUES (@u, @v, 1, 1, 1, @d);
      `);
    aceptoCache.delete(req.user.id);
    console.log(`🔏 [PRIVACIDAD] Usuario ${req.user.id} aceptó el aviso (versión ${config.privacidadVersion}).`);
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// Perfil de la sesión actual
app.get('/api/auth/me', requireAuth(), async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, req.user.id).query('SELECT * FROM Usuarios WHERE id = @id AND activo = 1');
    if (!r.recordset.length) return res.status(401).json({ error: 'Usuario no disponible' });
    res.json(publicUser(r.recordset[0]));
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- ESTACIONES -----------------

app.get('/api/workstations', requireAuth(), async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query('SELECT * FROM EstacionesTrabajo WHERE activo = 1 ORDER BY id ASC');
    res.json(result.recordset);
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- PROYECTOS (agrupan estaciones) -----------------

const SIN_PROYECTOS = { error: 'Los proyectos aún no están habilitados en este servidor (falta ejecutar la migración).' };

// Lista de proyectos activos. Sin la migración devuelve una lista vacía y todo funciona como antes.
app.get('/api/proyectos', requireAuth(), async (req, res) => {
  try {
    if (!proyectosHabilitados) return res.json([]);
    const p = await getPool();
    const r = await p.request().query(`
      SELECT pr.id, pr.codigo, pr.nombre, pr.color,
             (SELECT COUNT(*) FROM EstacionesTrabajo e WHERE e.proyecto_id = pr.id AND e.activo = 1) AS total_estaciones
        FROM Proyectos pr WHERE pr.activo = 1 ORDER BY pr.nombre ASC`);
    res.json(r.recordset);
  } catch (err) {
    fail(res, err);
  }
});

const COLOR_HEX = /^#[0-9a-fA-F]{6}$/;

app.post('/api/proyectos', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!proyectosHabilitados) return res.status(409).json(SIN_PROYECTOS);
    const codigo = String(req.body?.codigo ?? '').trim().slice(0, 50);
    const nombre = String(req.body?.nombre ?? '').trim().slice(0, 150);
    const color = COLOR_HEX.test(String(req.body?.color ?? '')) ? req.body.color : '#3B82F6';
    if (!codigo || !nombre) return res.status(400).json({ error: 'El código y el nombre del proyecto son obligatorios' });

    const p = await getPool();
    const dup = await p.request().input('codigo', sql.VarChar(50), codigo)
      .query('SELECT 1 FROM Proyectos WHERE codigo = @codigo AND activo = 1');
    if (dup.recordset.length) return res.status(409).json({ error: `Ya existe un proyecto con el código "${codigo}"` });

    const r = await p.request()
      .input('codigo', sql.VarChar(50), codigo)
      .input('nombre', sql.NVarChar(150), nombre)
      .input('color', sql.VarChar(20), color)
      .query('INSERT INTO Proyectos (codigo, nombre, color) OUTPUT INSERTED.id, INSERTED.codigo, INSERTED.nombre, INSERTED.color VALUES (@codigo, @nombre, @color)');
    console.log(`🗂️ [PROYECTO] ${req.user.id} creó el proyecto ${r.recordset[0].id} (${codigo} · ${nombre}).`);
    res.status(201).json({ ...r.recordset[0], total_estaciones: 0 });
  } catch (err) {
    fail(res, err);
  }
});

app.put('/api/proyectos/:id', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!proyectosHabilitados) return res.status(409).json(SIN_PROYECTOS);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });
    const { codigo, nombre, color } = req.body || {};
    if (codigo !== undefined && !String(codigo).trim()) return res.status(400).json({ error: 'El código no puede quedar vacío' });
    if (nombre !== undefined && !String(nombre).trim()) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    if (color !== undefined && !COLOR_HEX.test(String(color))) return res.status(400).json({ error: 'Color inválido' });

    const p = await getPool();
    const actual = await p.request().input('id', sql.Int, id).query('SELECT * FROM Proyectos WHERE id = @id AND activo = 1');
    if (!actual.recordset.length) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const antes = actual.recordset[0];
    const nuevo = {
      codigo: codigo !== undefined ? String(codigo).trim().slice(0, 50) : antes.codigo,
      nombre: nombre !== undefined ? String(nombre).trim().slice(0, 150) : antes.nombre,
      color: color !== undefined ? String(color) : antes.color,
    };
    if (nuevo.codigo !== antes.codigo) {
      const dup = await p.request().input('id', sql.Int, id).input('codigo', sql.VarChar(50), nuevo.codigo)
        .query('SELECT 1 FROM Proyectos WHERE codigo = @codigo AND activo = 1 AND id <> @id');
      if (dup.recordset.length) return res.status(409).json({ error: `Ya existe un proyecto con el código "${nuevo.codigo}"` });
    }
    const r = await p.request()
      .input('id', sql.Int, id)
      .input('codigo', sql.VarChar(50), nuevo.codigo)
      .input('nombre', sql.NVarChar(150), nuevo.nombre)
      .input('color', sql.VarChar(20), nuevo.color)
      .query(`UPDATE Proyectos SET codigo = @codigo, nombre = @nombre, color = @color
              OUTPUT INSERTED.id, INSERTED.codigo, INSERTED.nombre, INSERTED.color WHERE id = @id`);
    console.log(`✏️ [PROYECTO] ${req.user.id} editó el proyecto ${id} (${antes.nombre} → ${nuevo.nombre}).`);
    res.json(r.recordset[0]);
  } catch (err) {
    fail(res, err);
  }
});

// Eliminar un proyecto (baja lógica). Si todavía tiene estaciones, hay que moverlas o eliminarlas antes.
app.delete('/api/proyectos/:id', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    if (!proyectosHabilitados) return res.status(409).json(SIN_PROYECTOS);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    const pr = await p.request().input('id', sql.Int, id).query('SELECT codigo, nombre FROM Proyectos WHERE id = @id AND activo = 1');
    if (!pr.recordset.length) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const n = (await p.request().input('id', sql.Int, id)
      .query('SELECT COUNT(*) AS n FROM EstacionesTrabajo WHERE proyecto_id = @id AND activo = 1')).recordset[0].n;
    if (n > 0) {
      return res.status(409).json({ error: `El proyecto tiene ${n} estación(es). Muévelas a otro proyecto o elimínalas antes de borrarlo.` });
    }
    const sufijo = `~del${id}`;
    const codigoNuevo = `${String(pr.recordset[0].codigo).slice(0, 50 - sufijo.length)}${sufijo}`;
    await p.request().input('id', sql.Int, id).input('codigo', sql.VarChar(50), codigoNuevo)
      .query('UPDATE Proyectos SET activo = 0, codigo = @codigo WHERE id = @id');
    console.log(`🗑️ [PROYECTO] ${req.user.id} eliminó el proyecto ${id} (${pr.recordset[0].codigo} · ${pr.recordset[0].nombre}).`);
    res.json({ exito: true, id });
  } catch (err) {
    fail(res, err);
  }
});

// Comprueba que el proyecto indicado exista (null/undefined = sin proyecto)
async function proyectoExiste(p, proyectoId) {
  if (proyectoId === null || proyectoId === undefined) return true;
  if (!Number.isInteger(proyectoId) || proyectoId <= 0) return false;
  const r = await p.request().input('id', sql.Int, proyectoId).query('SELECT 1 AS ok FROM Proyectos WHERE id = @id AND activo = 1');
  return r.recordset.length > 0;
}

const MAPS_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'www.google.com', 'google.com', 'maps.google.com']);

// Parser de enlaces de Google Maps (solo dominios de Google, para evitar SSRF)
app.post('/api/workstations/parse-maps-url', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string' || url.length > 2000) {
      return res.status(400).json({ error: 'Debes proporcionar una URL válida de Google Maps' });
    }

    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      return res.status(400).json({ error: 'La URL no es válida' });
    }
    if (parsed.protocol !== 'https:' || !MAPS_HOSTS.has(parsed.hostname)) {
      return res.status(400).json({ error: 'Solo se aceptan enlaces de Google Maps (https).' });
    }

    let targetUrl = parsed.toString();
    let detectedName = '';

    if (parsed.hostname === 'goo.gl' || parsed.hostname === 'maps.app.goo.gl') {
      try {
        const response = await fetch(targetUrl, {
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });
        const finalHost = new URL(response.url).hostname;
        if (!MAPS_HOSTS.has(finalHost) && !finalHost.endsWith('.google.com')) {
          return res.status(400).json({ error: 'El enlace redirige fuera de Google Maps.' });
        }
        targetUrl = response.url;

        if (!targetUrl.includes('@') && !targetUrl.includes('!3d')) {
          const html = (await response.text()).slice(0, 2_000_000);
          const htmlMatch =
            html.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
            html.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
            html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/);
          if (htmlMatch) {
            return res.json({
              latitud: parseFloat(htmlMatch[1]),
              longitud: parseFloat(htmlMatch[2]),
              nombreSugerido: detectedName || 'Nueva Estación',
              urlResuelta: targetUrl,
            });
          }
        }
      } catch (fetchErr) {
        console.warn('Error resolviendo redirección de maps:', fetchErr.message);
      }
    }

    const placeMatch = targetUrl.match(/\/place\/([^/@?]+)/);
    if (placeMatch && placeMatch[1]) {
      try {
        detectedName = decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ');
      } catch (_) {}
    }

    const patterns = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&]q=(-?\d+\.\d+)[,%2C]+(-?\d+\.\d+)/i, /[?&]ll=(-?\d+\.\d+)[,%2C]+(-?\d+\.\d+)/i];
    for (const pattern of patterns) {
      const m = targetUrl.match(pattern);
      if (m) {
        return res.json({ latitud: parseFloat(m[1]), longitud: parseFloat(m[2]), nombreSugerido: detectedName, urlResuelta: targetUrl });
      }
    }

    return res.status(400).json({
      error: 'No se pudieron extraer coordenadas del enlace. Asegúrate de copiar el enlace de ubicación desde Google Maps.',
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/workstations', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const { codigo, nombre, latitud, longitud, radio_metros, color, descripcion } = req.body || {};
    if (!codigo || !nombre || !validCoords(latitud, longitud)) {
      return res.status(400).json({ error: 'Código, nombre y coordenadas válidas son obligatorios' });
    }
    const radio = isNum(radio_metros) && radio_metros > 0 && radio_metros <= 5000 ? radio_metros : 50.0;

    const p = await getPool();
    const proyectoId = proyectosHabilitados && req.body?.proyecto_id != null ? req.body.proyecto_id : null;
    if (!(await proyectoExiste(p, proyectoId))) return res.status(400).json({ error: 'El proyecto indicado no existe' });
    const result = await p.request()
      .input('proyectoId', sql.Int, proyectoId)
      .input('codigo', sql.VarChar(50), String(codigo).slice(0, 50))
      .input('nombre', sql.NVarChar(150), String(nombre).slice(0, 150))
      .input('latitud', sql.Float, latitud)
      .input('longitud', sql.Float, longitud)
      .input('radio', sql.Float, radio)
      .input('color', sql.VarChar(20), String(color || '#3B82F6').slice(0, 20))
      .input('descripcion', sql.NVarChar(255), String(descripcion || '').slice(0, 255))
      .query(`
        INSERT INTO EstacionesTrabajo (codigo, nombre, latitud, longitud, radio_metros, color, descripcion${proyectosHabilitados ? ', proyecto_id' : ''})
        OUTPUT INSERTED.*
        VALUES (@codigo, @nombre, @latitud, @longitud, @radio, @color, @descripcion${proyectosHabilitados ? ', @proyectoId' : ''});
      `);

    const nuevaEstacion = result.recordset[0];
    estacionesCache = null; // la próxima consulta vuelve a leer las estaciones
    io.emit('workstations_updated', nuevaEstacion);
    res.status(201).json(nuevaEstacion);
  } catch (err) {
    fail(res, err);
  }
});

// Editar una estación (nombre, código, ubicación, radio, color, descripción). Solo se envían los campos que cambian.
// Las asistencias pasadas apuntan a la estación por id, así que mostrarán el nombre nuevo.
app.put('/api/workstations/:id', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });

    const { codigo, nombre, latitud, longitud, radio_metros, color, descripcion } = req.body || {};
    if (codigo !== undefined && !String(codigo).trim()) return res.status(400).json({ error: 'El código no puede quedar vacío' });
    if (nombre !== undefined && !String(nombre).trim()) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
    if ((latitud !== undefined || longitud !== undefined) && !validCoords(latitud, longitud)) {
      return res.status(400).json({ error: 'Coordenadas inválidas' });
    }
    if (radio_metros !== undefined && !(isNum(radio_metros) && radio_metros > 0 && radio_metros <= 5000)) {
      return res.status(400).json({ error: 'El radio debe estar entre 1 y 5000 metros' });
    }

    const p = await getPool();
    const actual = await p.request().input('id', sql.Int, id)
      .query('SELECT * FROM EstacionesTrabajo WHERE id = @id AND activo = 1');
    if (!actual.recordset.length) return res.status(404).json({ error: 'Estación no encontrada' });
    const antes = actual.recordset[0];

    // proyecto_id: un número lo asigna, null lo deja "sin proyecto", si no viene no se toca
    const cambiaProyecto = proyectosHabilitados && req.body && req.body.proyecto_id !== undefined;
    const proyectoNuevo = cambiaProyecto ? req.body.proyecto_id : null;
    if (cambiaProyecto && !(await proyectoExiste(p, proyectoNuevo))) {
      return res.status(400).json({ error: 'El proyecto indicado no existe' });
    }

    const nuevo = {
      codigo: codigo !== undefined ? String(codigo).trim().slice(0, 50) : antes.codigo,
      nombre: nombre !== undefined ? String(nombre).trim().slice(0, 150) : antes.nombre,
      latitud: latitud !== undefined ? latitud : antes.latitud,
      longitud: longitud !== undefined ? longitud : antes.longitud,
      radio: radio_metros !== undefined ? radio_metros : antes.radio_metros,
      color: color !== undefined ? String(color).slice(0, 20) : antes.color,
      descripcion: descripcion !== undefined ? String(descripcion || '').slice(0, 255) : antes.descripcion,
    };

    if (nuevo.codigo !== antes.codigo) {
      const dup = await p.request().input('id', sql.Int, id).input('codigo', sql.VarChar(50), nuevo.codigo)
        .query('SELECT 1 FROM EstacionesTrabajo WHERE codigo = @codigo AND id <> @id');
      if (dup.recordset.length) return res.status(409).json({ error: `Ya existe una estación con el código "${nuevo.codigo}"` });
    }

    const result = await p.request()
      .input('id', sql.Int, id)
      .input('codigo', sql.VarChar(50), nuevo.codigo)
      .input('nombre', sql.NVarChar(150), nuevo.nombre)
      .input('latitud', sql.Float, nuevo.latitud)
      .input('longitud', sql.Float, nuevo.longitud)
      .input('radio', sql.Float, nuevo.radio)
      .input('color', sql.VarChar(20), nuevo.color)
      .input('descripcion', sql.NVarChar(255), nuevo.descripcion)
      .input('proyectoId', sql.Int, proyectoNuevo)
      .query(`
        UPDATE EstacionesTrabajo
        SET codigo = @codigo, nombre = @nombre, latitud = @latitud, longitud = @longitud,
            radio_metros = @radio, color = @color, descripcion = @descripcion
            ${cambiaProyecto ? ', proyecto_id = @proyectoId' : ''}
        OUTPUT INSERTED.*
        WHERE id = @id AND activo = 1;
      `);

    const estacion = result.recordset[0];
    estacionesCache = null; // la próxima consulta vuelve a leer las estaciones
    lastPings.clear();      // la geocerca cambió: se vuelve a calcular quién está dentro con el siguiente punto GPS
    io.emit('workstations_updated', estacion);

    const cambios = [];
    if (antes.codigo !== estacion.codigo) cambios.push(`código: ${antes.codigo} → ${estacion.codigo}`);
    if (antes.nombre !== estacion.nombre) cambios.push(`nombre: ${antes.nombre} → ${estacion.nombre}`);
    if (antes.radio_metros !== estacion.radio_metros) cambios.push(`radio: ${antes.radio_metros} → ${estacion.radio_metros} m`);
    if (antes.latitud !== estacion.latitud || antes.longitud !== estacion.longitud) cambios.push('ubicación');
    if (antes.color !== estacion.color) cambios.push('color');
    if ((antes.descripcion || '') !== (estacion.descripcion || '')) cambios.push('descripción');
    if (cambiaProyecto && (antes.proyecto_id ?? null) !== (estacion.proyecto_id ?? null)) cambios.push(`proyecto: ${antes.proyecto_id ?? 'ninguno'} → ${estacion.proyecto_id ?? 'ninguno'}`);
    console.log(`✏️ [ESTACIÓN] ${req.user.id} editó la estación ${id}: ${cambios.join('; ') || 'sin cambios'}.`);

    res.json(estacion);
  } catch (err) {
    fail(res, err);
  }
});

// Eliminar una estación. Es una baja lógica (activo = 0): el historial de asistencia y los recorridos conservan
// su nombre, pero deja de usarse para detectar si un trabajador está dentro de zona.
app.delete('/api/workstations/:id', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });

    const p = await getPool();
    const est = await p.request().input('id', sql.Int, id)
      .query('SELECT id, codigo, nombre FROM EstacionesTrabajo WHERE id = @id AND activo = 1');
    if (!est.recordset.length) return res.status(404).json({ error: 'Estación no encontrada' });
    const { codigo, nombre } = est.recordset[0];

    // El código es único: se le añade un sufijo para poder volver a usarlo en una estación nueva
    const sufijo = `~del${id}`;
    const codigoNuevo = `${String(codigo).slice(0, 50 - sufijo.length)}${sufijo}`;

    await p.request().input('id', sql.Int, id).input('codigo', sql.VarChar(50), codigoNuevo).query(`
      UPDATE EstacionesTrabajo SET activo = 0, codigo = @codigo WHERE id = @id;
      -- los trabajadores que figuraban dentro de esa estación quedan sin estación hasta su próximo punto GPS
      UPDATE UbicacionesEnVivo SET estacion_actual_id = NULL, dentro_de_estacion = 0 WHERE estacion_actual_id = @id;
    `);

    estacionesCache = null; // la próxima consulta vuelve a leer las estaciones
    lastPings.clear();      // las geocercas guardadas por trabajador ya no son válidas
    io.emit('workstations_deleted', { id });
    console.log(`🗑️ [ESTACIÓN] ${req.user.id} eliminó la estación ${id} (${codigo} · ${nombre}).`);
    res.json({ exito: true, id, nombre });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- USUARIOS (administración) -----------------

app.get('/api/users', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const p = await getPool();
    // Nunca se envían el PIN ni el descriptor facial al navegador
    // La foto de referencia NO viaja en la lista (pesa cientos de KB por usuario): se pide aparte en
    // /api/photos/user/:id/reference. foto_ref_bytes sirve de versión para el caché del navegador.
    const result = await p.request().input('v', sql.Int, config.privacidadVersion).query(
      `SELECT id, codigo_empleado, nombre, correo, rol, cargo, telefono, activo, facial_enrolado,
              ${dniColumna ? 'dni,' : ''}
              ISNULL(DATALENGTH(foto_referencia_url), 0) AS foto_ref_bytes
              ${privacidadTabla ? ', (SELECT MAX(a.aceptado_en) FROM AceptacionesPrivacidad a WHERE a.usuario_id = Usuarios.id AND a.version = @v) AS privacidad_aceptada_en' : ''}
         FROM Usuarios`
    );
    res.json(result.recordset);
  } catch (err) {
    fail(res, err);
  }
});

// ----- Plan de la instalación: máximo de trabajadores activos (MAX_TRABAJADORES; vacío = sin límite) -----

async function contarTrabajadoresActivos(p) {
  const r = await p.request().query("SELECT COUNT(*) AS n FROM Usuarios WHERE rol = 'trabajador' AND activo = 1");
  return r.recordset[0].n;
}

// true = hay cupo. Si el plan está lleno responde 409 con un mensaje claro y devuelve false.
async function hayCupo(p, res) {
  const limite = config.maxTrabajadores;
  if (!limite) return true;
  const activos = await contarTrabajadoresActivos(p);
  if (activos < limite) return true;
  res.status(409).json({
    error: `Su plan permite ${limite} trabajadores activos y ya tiene ${activos}. Dé de baja a alguno o contacte a su proveedor para ampliar el plan.`,
    codigo: 'LIMITE_PLAN',
    limite,
    activos,
  });
  return false;
}

// Uso del plan, para mostrarlo en el panel (limite null = sin límite)
app.get('/api/plan', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const p = await getPool();
    res.json({ limite: config.maxTrabajadores || null, activos: await contarTrabajadoresActivos(p) });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/users', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const { codigo_empleado, nombre, correo, cargo, telefono, pin, dni } = req.body || {};

    // Con el ingreso por DNI habilitado, el código del trabajador ES su DNI (no se escribe aparte)
    const documento = normalizarDni(dni);
    const codigoFinal = dniColumna ? documento : String(codigo_empleado || '').trim();
    if (!nombre || (!dniColumna && !codigoFinal)) {
      return res.status(400).json({ error: dniColumna ? 'El DNI y el nombre son obligatorios' : 'Código de empleado y nombre son obligatorios' });
    }
    if (pin !== undefined && pin !== null && pin !== '' && !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: 'El PIN debe tener entre 4 y 6 dígitos' });
    }
    if (!pinColumnWide) {
      return res.status(500).json({ error: 'Falta migrar la base de datos: ejecuta  node service/migrate-security.mjs' });
    }

    const p = await getPool();
    const existe = await p.request().input('codigo', sql.VarChar(50), codigoFinal).query('SELECT id FROM Usuarios WHERE codigo_empleado = @codigo');
    if (existe.recordset.length > 0) {
      return res.status(400).json({ error: dniColumna ? 'Ya existe un usuario con ese DNI' : 'Ya existe un usuario con este código de empleado' });
    }

    // DNI: obligatorio cuando el ingreso con DNI está habilitado
    if (dniColumna) {
      if (!dniValido(documento)) return res.status(400).json({ error: 'Indique el DNI del trabajador (8 dígitos; para carnet de extranjería, 8 a 12 letras y números).' });
      const dup = await p.request().input('dni', sql.VarChar(12), documento).query('SELECT 1 AS ok FROM Usuarios WHERE dni = @dni');
      if (dup.recordset.length) return res.status(400).json({ error: 'Ya existe un usuario con ese DNI' });
    }

    if (!(await hayCupo(p, res))) return;

    const email = correo || `${codigoFinal.toLowerCase()}@smi.pe`;
    // Si no se indica PIN, se genera uno aleatorio y se muestra UNA sola vez
    const pinInicial = pin ? String(pin) : String(crypto.randomInt(100000, 999999));

    const result = await p.request()
      .input('codigo', sql.VarChar(50), codigoFinal.slice(0, 50))
      .input('nombre', sql.NVarChar(150), String(nombre).slice(0, 150))
      .input('correo', sql.VarChar(150), String(email).slice(0, 150))
      .input('pin', sql.VarChar(200), await hashPinAsync(pinInicial))
      .input('cargo', sql.NVarChar(100), String(cargo || 'Operador de Campo').slice(0, 100))
      .input('telefono', sql.VarChar(30), String(telefono || '').slice(0, 30))
      .input('dni', sql.VarChar(12), dniColumna ? documento : null)
      .query(`
        INSERT INTO Usuarios (codigo_empleado, nombre, correo, pin, rol, cargo, telefono, activo, facial_enrolado, creado_en${dniColumna ? ', dni' : ''})
        OUTPUT INSERTED.id, INSERTED.codigo_empleado, INSERTED.nombre, INSERTED.correo, INSERTED.rol, INSERTED.cargo,
               INSERTED.telefono, INSERTED.activo, INSERTED.facial_enrolado${dniColumna ? ', INSERTED.dni' : ''}
        VALUES (@codigo, @nombre, @correo, @pin, 'trabajador', @cargo, @telefono, 1, 0, GETDATE()${dniColumna ? ', @dni' : ''});
      `);

    const nuevoUsuario = result.recordset[0];
    emitStaff('user_created', nuevoUsuario);
    res.status(201).json({ ...nuevoUsuario, pinInicial });
  } catch (err) {
    fail(res, err);
  }
});

// ----- Gestión de datos del personal (rectificación, baja, acceso y supresión) -----

// Devuelve el trabajador o responde el error; solo se gestionan cuentas de trabajador
async function trabajadorParaGestion(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Solicitud inválida' }); return null; }
  const p = await getPool();
  const r = await p.request().input('id', sql.Int, id).query('SELECT id, codigo_empleado, nombre, rol, activo FROM Usuarios WHERE id = @id');
  const u = r.recordset[0];
  if (!u) { res.status(404).json({ error: 'Trabajador no encontrado' }); return null; }
  if (u.rol !== 'trabajador') { res.status(400).json({ error: 'Esta acción solo se aplica a cuentas de trabajador.' }); return null; }
  return u;
}
const olvidarUsuario = (id) => { activoCache.delete(id); aceptoCache.delete(id); turnoCache.delete(id); };

// Corregir los datos del trabajador (rectificación)
app.put('/api/users/:id', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const u = await trabajadorParaGestion(req, res);
    if (!u) return;
    const { nombre, cargo, correo, telefono, dni } = req.body || {};
    const sets = [];
    const rq = (await getPool()).request().input('id', sql.Int, u.id);
    if (nombre !== undefined) {
      if (typeof nombre !== 'string' || !nombre.trim()) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
      sets.push('nombre = @nombre'); rq.input('nombre', sql.NVarChar(150), nombre.trim().slice(0, 150));
    }
    if (cargo !== undefined) { sets.push('cargo = @cargo'); rq.input('cargo', sql.NVarChar(100), String(cargo || '').trim().slice(0, 100)); }
    if (correo !== undefined) {
      if (typeof correo !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim())) return res.status(400).json({ error: 'Correo inválido' });
      sets.push('correo = @correo'); rq.input('correo', sql.VarChar(150), correo.trim().slice(0, 150));
    }
    if (telefono !== undefined) { sets.push('telefono = @telefono'); rq.input('telefono', sql.VarChar(30), String(telefono || '').trim().slice(0, 30)); }
    if (dni !== undefined) {
      if (!dniColumna) return res.status(503).json({ error: 'El ingreso con DNI aún no está habilitado en el servidor: ejecute  npm run migrate-dni  y reinicie.', codigo: 'DNI_NO_DISPONIBLE' });
      const documento = normalizarDni(dni);
      if (!dniValido(documento)) return res.status(400).json({ error: 'DNI inválido (8 dígitos; para carnet de extranjería, 8 a 12 letras y números).' });
      sets.push('dni = @dni', 'codigo_empleado = @dni'); rq.input('dni', sql.VarChar(12), documento); // el código del trabajador es su DNI
    }
    if (!sets.length) return res.status(400).json({ error: 'No hay nada que cambiar' });
    try {
      await rq.query(`UPDATE Usuarios SET ${sets.join(', ')} WHERE id = @id`);
    } catch (err) {
      if (err.number === 2627 || err.number === 2601) {
        return res.status(400).json({ error: /dni|codigo/i.test(err.message) ? 'Ese DNI ya está registrado en otra cuenta' : 'Ese correo ya está en uso por otra cuenta' });
      }
      throw err;
    }
    console.log(`🗂️ [DATOS] Admin ${req.user.id} corrigió los datos del trabajador ${u.id} (${sets.length} campo(s)).`);
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// Nuevo PIN (por ejemplo, si perdió el celular): se genera uno aleatorio y se muestra UNA sola vez
app.post('/api/users/:id/reset-pin', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const u = await trabajadorParaGestion(req, res);
    if (!u) return;
    if (!pinColumnWide) return res.status(500).json({ error: 'Falta migrar la base de datos: ejecuta  node service/migrate-security.mjs' });
    const pinNuevo = String(crypto.randomInt(100000, 999999));
    const p = await getPool();
    await p.request().input('id', sql.Int, u.id).input('pin', sql.VarChar(200), await hashPinAsync(pinNuevo)).query('UPDATE Usuarios SET pin = @pin WHERE id = @id');
    loginUserLimiter.reset(`user:${u.id}`);
    console.log(`🗂️ [DATOS] Admin ${req.user.id} cambió el PIN del trabajador ${u.id}.`);
    res.json({ exito: true, pinNuevo });
  } catch (err) {
    fail(res, err);
  }
});

// Baja: desactiva la cuenta y borra su rostro. Con eliminarDatos=true borra además TODO su historial y su usuario (irreversible).
app.post('/api/users/:id/baja', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const u = await trabajadorParaGestion(req, res);
    if (!u) return;
    const { eliminarDatos, confirmar } = req.body || {};
    const p = await getPool();
    const activo = await p.request().input('u', sql.Int, u.id).query("SELECT id FROM RegistroAsistencia WHERE usuario_id = @u AND estado = 'activo'");
    if (activo.recordset.length) {
      return res.status(409).json({ error: 'El trabajador tiene un turno activo. Primero registre su salida o fuerce la salida desde el panel.', codigo: 'TURNO_ACTIVO' });
    }
    if (eliminarDatos === true) {
      if (confirmar !== u.codigo_empleado) {
        return res.status(400).json({ error: 'Para eliminar todos los datos escriba el código de empleado exacto.', codigo: 'CONFIRMACION_INVALIDA' });
      }
      const borrados = await eliminarTodo(p, u.id);
      olvidarUsuario(u.id);
      console.warn(`🗂️ [DATOS] Admin ${req.user.id} ELIMINÓ todos los datos del trabajador ${u.codigo_empleado}:`, JSON.stringify(borrados));
      emitStaff('user_removed', { id: u.id });
      return res.json({ exito: true, eliminado: true, borrados });
    }
    await darDeBaja(p, u.id);
    olvidarUsuario(u.id);
    console.log(`🗂️ [DATOS] Admin ${req.user.id} dio de baja al trabajador ${u.codigo_empleado} (rostro borrado).`);
    res.json({ exito: true, eliminado: false });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/users/:id/reactivar', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const u = await trabajadorParaGestion(req, res);
    if (!u) return;
    const p = await getPool();
    // Reactivar a alguien que ya está activo no consume cupo; a uno dado de baja sí
    if (!u.activo && !(await hayCupo(p, res))) return;
    await p.request().input('id', sql.Int, u.id).query('UPDATE Usuarios SET activo = 1 WHERE id = @id');
    olvidarUsuario(u.id);
    console.log(`🗂️ [DATOS] Admin ${req.user.id} reactivó al trabajador ${u.codigo_empleado}.`);
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// Copia de todos los datos del trabajador (derecho de acceso). ?fotos=1 incluye las fotos (el archivo puede pesar mucho)
app.get('/api/users/:id/export', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const u = await trabajadorParaGestion(req, res);
    if (!u) return;
    const datos = await exportarDatos(await getPool(), u.id, { fotos: req.query.fotos === '1' });
    console.log(`🗂️ [DATOS] Admin ${req.user.id} descargó los datos del trabajador ${u.codigo_empleado}${req.query.fotos === '1' ? ' (con fotos)' : ''}.`);
    const nombre = `datos-${String(u.codigo_empleado).replace(/[^\w-]/g, '_')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.type('application/json').send(JSON.stringify(datos, null, 2));
  } catch (err) {
    fail(res, err);
  }
});

// Enrolamiento facial hecho por un administrador (foto de referencia)
app.post('/api/users/:id/enrol-face', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { descriptorFacial, fotoReferencia } = req.body || {};
    const descriptor = parseDescriptor(descriptorFacial);

    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID de usuario inválido' });
    if (!descriptor) {
      return res.status(400).json({ error: 'El descriptor facial no es válido. Intente con otra fotografía.' });
    }
    if (!validPhoto(fotoReferencia, 8_000_000)) {
      return res.status(400).json({ error: 'La foto no es válida o es demasiado grande. Use una imagen JPG, PNG o WebP.' });
    }

    const p = await getPool();
    const r = await p.request()
      .input('id', sql.Int, id)
      .input('descriptor', sql.NVarChar(sql.MAX), JSON.stringify(descriptor))
      .input('foto', sql.NVarChar(sql.MAX), fotoReferencia)
      .query('UPDATE Usuarios SET descriptor_facial = @descriptor, foto_referencia_url = @foto, facial_enrolado = 1 WHERE id = @id');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    console.log(`✅ [BIOMETRÍA] Admin ${req.user.id} enroló el rostro del usuario ${id}.`);
    emitStaff('user_face_enrolled', { usuarioId: id });
    res.json({ exito: true, mensaje: 'Rostro maestro enrolado exitosamente' });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/users/:id/reset-face', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID de usuario inválido' });

    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id)
      .query('UPDATE Usuarios SET descriptor_facial = NULL, foto_referencia_url = NULL, facial_enrolado = 0 WHERE id = @id');
    if (!r.rowsAffected[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    console.log(`🔄 [BIOMETRÍA] Admin ${req.user.id} reseteó la biometría del usuario ${id}.`);
    emitStaff('user_face_enrolled', { usuarioId: id, reseteado: true });
    res.json({ exito: true, mensaje: 'Biometría reseteada. El trabajador se auto-enrolará en su próxima marcación.' });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- BIOMETRÍA FACIAL (verificación en el servidor) -----------------

// segundosAtras: el hecho ocurrió antes de enterarnos (p. ej. el celular lo avisó al recuperar internet)
async function registrarFraude({ usuarioId, tipoEvento, foto, similitud, notas, segundosAtras = 0 }) {
  try {
    const p = await getPool();
    const seg = Number.isFinite(segundosAtras) && segundosAtras > 0 ? Math.round(segundosAtras) : 0;
    await p.request()
      .input('usuarioId', sql.Int, usuarioId)
      .input('tipo', sql.VarChar(50), tipoEvento)
      .input('foto', sql.NVarChar(sql.MAX), foto || null)
      .input('similitud', sql.Float, similitud || 0)
      .input('notas', sql.NVarChar(255), notas)
      .input('seg', sql.Int, seg)
      .query(`
        INSERT INTO AuditoriaFraudeFacial (usuario_id, tipo_evento, foto_intento_url, similitud_obtenida, notas, fecha_intento)
        VALUES (@usuarioId, @tipo, @foto, @similitud, @notas, DATEADD(SECOND, -@seg, GETDATE()));
      `);
    console.warn(`🚨 [ALERTA DE FRAUDE] Usuario ${usuarioId}: ${tipoEvento} (${similitud}%).`);
    emitStaff('fraud_alert', {
      usuarioId,
      tipoEvento,
      similitudObtenida: similitud,
      notas,
      fecha: new Date(Date.now() - seg * 1000).toISOString(),
    });
    return true;
  } catch (err) {
    console.error('No se pudo registrar la auditoría de fraude:', err.message);
    return false;
  }
}

// Para qué se puede pedir una verificación facial (cada tipo genera su propio ticket de un solo uso)
const TIPOS_VERIFICACION = ['entrada', 'salida', 'almuerzo_inicio', 'almuerzo_fin'];

// Intentos fallidos de la prueba de vida (retos aleatorios): el celular avisa desde el 2.º seguido. Se guarda la foto del
// intento para que un administrador pueda ver, por ejemplo, un video o una foto frente a la cámara.
const lastLivenessFail = new Map(); // usuarioId -> instante del último aviso
app.post('/api/biometric/liveness-fail', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { foto, motivo, intentos } = req.body || {};
    if (!validPhoto(foto)) return res.status(400).json({ error: 'Solicitud inválida' });
    const userId = req.user.id;
    const previo = lastLivenessFail.get(userId) || 0;
    if (Date.now() - previo < 15_000) return res.json({ exito: true, omitido: true }); // no se llena la auditoría
    lastLivenessFail.set(userId, Date.now());
    const m = typeof motivo === 'string' ? motivo.replace(/[^a-z_]/gi, '').slice(0, 30) : 'desconocido';
    const n = Number.isInteger(intentos) && intentos > 0 && intentos < 100 ? intentos : 0;
    await registrarFraude({
      usuarioId: userId,
      tipoEvento: 'FALLA_PRUEBA_VIDA',
      foto,
      similitud: 0,
      notas: `Prueba de vida fallida (${m}); intentos fallidos seguidos: ${n}`,
    });
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// El cliente envía el descriptor de su rostro; el servidor lo compara con el enrolado.
// Si coincide, devuelve un ticket de un solo uso que exige check-in / check-out.
app.post('/api/biometric/verify', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { descriptor, foto, tipo } = req.body || {};
    const live = parseDescriptor(descriptor);
    if (!live || !validPhoto(foto) || !TIPOS_VERIFICACION.includes(tipo)) {
      return res.status(400).json({ error: 'Datos biométricos inválidos' });
    }

    const userId = req.user.id;
    const lockKey = `face:${userId}`;
    const blocked = faceFailLimiter.blockedFor(lockKey);
    if (blocked) {
      return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta en ${Math.ceil(blocked / 60)} min o contacta a tu supervisor.` });
    }

    const p = await getPool();
    const r = await p.request().input('id', sql.Int, userId).query('SELECT descriptor_facial, facial_enrolado, activo FROM Usuarios WHERE id = @id');
    const user = r.recordset[0];
    if (!user || !user.activo) return res.status(401).json({ error: 'Usuario no disponible' });

    const enrolled = user.facial_enrolado ? parseDescriptor(user.descriptor_facial) : null;
    if (!enrolled) return res.status(409).json({ error: 'Aún no tienes un rostro enrolado', needsEnrol: true });

    const distance = euclideanDistance(live, enrolled);
    const similarity = similarityFromDistance(distance);
    const isMatch = distance < config.faceMatchThreshold;

    if (!isMatch) {
      faceFailLimiter.fail(lockKey);
      await registrarFraude({
        usuarioId: userId,
        tipoEvento: 'SUPLANTACION_ROSTRO',
        foto,
        similitud: similarity,
        notas: `Intento con rostro no autorizado (Similitud: ${similarity}%)`,
      });
      return res.json({ isMatch: false, similarity });
    }

    faceFailLimiter.reset(lockKey);
    res.json({ isMatch: true, similarity, ticket: issueBioTicket(userId, tipo, similarity) });
  } catch (err) {
    fail(res, err);
  }
});

// Auto-enrolamiento del propio trabajador (solo si todavía no tiene rostro enrolado)
app.post('/api/biometric/enrol', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    if (!ALLOW_SELF_ENROL) return res.status(403).json({ error: 'El enrolamiento debe hacerlo un administrador.' });

    const { descriptor, foto, tipo } = req.body || {};
    const live = parseDescriptor(descriptor);
    if (!live || !validPhoto(foto) || !TIPOS_VERIFICACION.includes(tipo)) {
      return res.status(400).json({ error: 'Datos biométricos inválidos' });
    }

    const p = await getPool();
    const r = await p.request()
      .input('id', sql.Int, req.user.id)
      .input('descriptor', sql.NVarChar(sql.MAX), JSON.stringify(live))
      .input('foto', sql.NVarChar(sql.MAX), foto)
      .query('UPDATE Usuarios SET descriptor_facial = @descriptor, foto_referencia_url = @foto, facial_enrolado = 1 WHERE id = @id AND activo = 1 AND facial_enrolado = 0');

    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: 'Tu rostro ya está enrolado. Verifica tu identidad normalmente.' });
    }

    console.log(`✅ [BIOMETRÍA] Usuario ${req.user.id} enroló su rostro maestro.`);
    emitStaff('user_face_enrolled', { usuarioId: req.user.id });
    res.json({ exito: true, similarity: 100, ticket: issueBioTicket(req.user.id, tipo, 100) });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- DASHBOARD (administración) -----------------

app.get('/api/dashboard/live', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(`
      SELECT
        u.id as usuario_id, u.codigo_empleado, u.nombre as nombre_usuario, u.cargo, u.telefono,
        ${pushTablasListas ? 'CASE WHEN EXISTS (SELECT 1 FROM SuscripcionesPush sp WHERE sp.usuario_id = u.id) THEN 1 ELSE 0 END AS push_activo,' : ''}
        a.id as asistencia_id, a.hora_ingreso, CASE WHEN a.foto_ingreso_url IS NULL THEN 0 ELSE 1 END AS tiene_foto_ingreso, a.estado as estado_asistencia,
        uv.latitud, uv.longitud, uv.precision, uv.ultimo_ping, uv.dentro_de_estacion,
        ${bateriaColumnas ? 'uv.bateria, uv.cargando,' : ''}
        ${almuerzoTabla ? 'al.inicio_en AS almuerzo_inicio, DATEDIFF(SECOND, al.inicio_en, GETDATE()) AS almuerzo_segundos,' : ''}
        DATEDIFF(SECOND, uv.ultimo_ping, GETDATE()) AS segundos_sin_ping,
        e.id as estacion_id, e.nombre as estacion_nombre, e.codigo as estacion_codigo, e.color as estacion_color
      FROM Usuarios u
      LEFT JOIN RegistroAsistencia a ON u.id = a.usuario_id AND a.estado = 'activo'
      ${almuerzoTabla ? 'LEFT JOIN AlmuerzosTurno al ON al.asistencia_id = a.id AND al.fin_en IS NULL' : ''}
      LEFT JOIN UbicacionesEnVivo uv ON u.id = uv.usuario_id AND uv.activo = 1
      LEFT JOIN EstacionesTrabajo e ON uv.estacion_actual_id = e.id
      WHERE u.rol = 'trabajador' AND u.activo = 1
      ORDER BY a.hora_ingreso DESC, u.nombre ASC;
    `);

    const ahoraMs = Date.now();
    const trabajadores = result.recordset.map((w) => {
      const imp = gpsImprecisos.get(w.usuario_id);
      return {
        ...w,
        ...(pushTablasListas ? { push_activo: w.push_activo || appNativaActiva(w.usuario_id) ? 1 : 0 } : {}),
        en_almuerzo: Boolean(w.almuerzo_inicio),
        gps_imprecisa: Boolean(imp && ahoraMs - imp.t < 60_000),
      };
    });
    const activos = trabajadores.filter((w) => w.estado_asistencia === 'activo');
    const dentro = activos.filter((w) => w.dentro_de_estacion).length;
    const almorzando = activos.filter((w) => w.en_almuerzo).length;

    // Hora actual del servidor de base de datos: referencia para calcular el tiempo en turno
    const reloj = await p.request().query('SELECT GETDATE() AS ahora');

    res.json({
      ahora: reloj.recordset[0].ahora,
      resumen: {
        totalTrabajadores: trabajadores.length,
        activosConteo: activos.length,
        dentroEstacionConteo: dentro,
        // quien está almorzando no cuenta como "fuera de zona"
        fueraEstacionConteo: activos.filter((w) => !w.dentro_de_estacion && !w.en_almuerzo).length,
        almuerzoConteo: almorzando,
      },
      almuerzoMinutos: config.almuerzoMinutos,
      trabajadores,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- ASISTENCIA (trabajador) -----------------

// Estado del turno del propio trabajador
app.get('/api/me/shift', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, req.user.id).query(`
      SELECT a.id as asistencia_id, a.hora_ingreso, a.estado as estado_asistencia,
             ${dispositivoColumna ? 'a.dispositivo_id,' : ''}
             uv.latitud, uv.longitud, uv.precision, uv.dentro_de_estacion, uv.estacion_actual_id as estacion_id
      FROM RegistroAsistencia a
      LEFT JOIN UbicacionesEnVivo uv ON uv.usuario_id = a.usuario_id AND uv.activo = 1
      WHERE a.usuario_id = @id AND a.estado = 'activo'
    `);
    const fila = r.recordset[0];
    if (!fila) return res.json(null);
    // El identificador del dispositivo no sale del servidor: solo se informa si este teléfono es el del turno
    const { dispositivo_id: atado, ...resto } = fila;

    // Almuerzo del turno: si está almorzando (y desde hace cuánto, con el reloj del servidor) y cuántos lleva
    let almuerzo = null;
    if (almuerzoTabla) {
      const a = await p.request().input('a', sql.Int, fila.asistencia_id).query(`
        SELECT COUNT(*) AS total,
               MAX(CASE WHEN fin_en IS NULL THEN 1 ELSE 0 END) AS abierto,
               DATEDIFF(SECOND, MIN(CASE WHEN fin_en IS NULL THEN inicio_en END), GETDATE()) AS segundos_abierto,
               ISNULL(SUM(DATEDIFF(SECOND, inicio_en, fin_en)), 0) AS segundos_usados
        FROM AlmuerzosTurno WHERE asistencia_id = @a`);
      const x = a.recordset[0];
      almuerzo = {
        habilitado: true,
        enAlmuerzo: x.abierto === 1,
        segundosEnAlmuerzo: x.abierto === 1 ? x.segundos_abierto : 0,
        realizados: x.total - (x.abierto === 1 ? 1 : 0),
        maximo: config.almuerzosPorTurno,
        permitidoMinutos: config.almuerzoMinutos,
        segundosUsados: x.segundos_usados,
      };
    }
    res.json({ ...resto, en_otro_dispositivo: Boolean(atado && atado !== dispositivoDe(req)), almuerzo });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/attendance/check-in', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { latitud, longitud, precision, fotoIngreso, ticket, antiguedadMs } = req.body || {};
    const usuarioId = req.user.id;

    if (!validCoords(latitud, longitud)) {
      return res.status(400).json({ error: 'latitud y longitud válidas son requeridas' });
    }
    if (!isNum(precision) || precision <= 0 || precision > config.gpsMaxPrecisionCheckin) {
      return res.status(400).json({
        codigo: 'GPS_IMPRECISO',
        error: `Su ubicación no es lo bastante precisa (${isNum(precision) ? `±${Math.round(precision)} m` : 'sin dato'}). Se requiere ±${config.gpsMaxPrecisionCheckin} m o menos: active la ubicación de alta precisión, permita la ubicación "precisa" al navegador y salga a un lugar abierto.`,
      });
    }
    if (isNum(antiguedadMs) && antiguedadMs > config.gpsMaxAgeMs) {
      return res.status(400).json({
        codigo: 'GPS_DESACTUALIZADO',
        error: 'La ubicación está desactualizada. Espere a que el GPS se actualice e intente de nuevo.',
      });
    }
    if (!validPhoto(fotoIngreso)) {
      return res.status(400).json({ error: 'La foto de evidencia es OBLIGATORIA para registrar entrada' });
    }

    const bio = consumeBioTicket(ticket, usuarioId, 'entrada');
    if (!bio) {
      return res.status(403).json({ error: 'Verificación facial requerida o vencida. Repite el reconocimiento facial.' });
    }

    const p = await getPool();
    const existente = await p.request().input('usuarioId', sql.Int, usuarioId)
      .query("SELECT id FROM RegistroAsistencia WHERE usuario_id = @usuarioId AND estado = 'activo'");
    if (existente.recordset.length > 0) {
      return res.status(400).json({ error: 'Ya existe un turno activo para este trabajador' });
    }

    const geo = await detectarEstacionTrabajo(latitud, longitud);

    const registroResultado = await p.request()
      .input('usuarioId', sql.Int, usuarioId)
      .input('lat', sql.Float, latitud)
      .input('lng', sql.Float, longitud)
      .input('acc', sql.Float, optNum(precision))
      .input('estId', sql.Int, geo.estacionId)
      .input('foto', sql.NVarChar(sql.MAX), fotoIngreso)
      .input('similitud', sql.Float, bio.sim)
      .input('dentro', sql.Bit, geo.dentroDeEstacion ? 1 : 0)
      .input('dispositivo', sql.VarChar(64), dispositivoDe(req))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;

        DECLARE @TempAsistencia TABLE (
          id INT, usuario_id INT, hora_ingreso DATETIME, latitud_ingreso FLOAT, longitud_ingreso FLOAT,
          precision_ingreso FLOAT, estacion_ingreso_id INT, foto_ingreso_url NVARCHAR(MAX),
          similitud_facial FLOAT, verificacion_facial_exitosa BIT, metodo_validacion VARCHAR(40), estado VARCHAR(20)
        );

        INSERT INTO RegistroAsistencia (
          usuario_id, hora_ingreso, latitud_ingreso, longitud_ingreso, precision_ingreso,
          estacion_ingreso_id, foto_ingreso_url, similitud_facial, verificacion_facial_exitosa,
          metodo_validacion, estado${dispositivoColumna ? ', dispositivo_id' : ''}
        )
        OUTPUT INSERTED.id, INSERTED.usuario_id, INSERTED.hora_ingreso, INSERTED.latitud_ingreso,
               INSERTED.longitud_ingreso, INSERTED.precision_ingreso, INSERTED.estacion_ingreso_id,
               INSERTED.foto_ingreso_url, INSERTED.similitud_facial, INSERTED.verificacion_facial_exitosa,
               INSERTED.metodo_validacion, INSERTED.estado
        INTO @TempAsistencia
        VALUES (@usuarioId, GETDATE(), @lat, @lng, @acc, @estId, @foto, @similitud, 1, 'facial_biometrico', 'activo'${dispositivoColumna ? ', @dispositivo' : ''});

        DECLARE @asistId INT = (SELECT TOP 1 id FROM @TempAsistencia);

        IF EXISTS (SELECT 1 FROM UbicacionesEnVivo WHERE usuario_id = @usuarioId)
        BEGIN
          UPDATE UbicacionesEnVivo
          SET asistencia_id = @asistId, latitud = @lat, longitud = @lng, precision = @acc,
              estacion_actual_id = @estId, dentro_de_estacion = @dentro, activo = 1, ultimo_ping = GETDATE()
          WHERE usuario_id = @usuarioId;
        END
        ELSE
        BEGIN
          INSERT INTO UbicacionesEnVivo (usuario_id, asistencia_id, latitud, longitud, precision, estacion_actual_id, dentro_de_estacion, activo, ultimo_ping)
          VALUES (@usuarioId, @asistId, @lat, @lng, @acc, @estId, @dentro, 1, GETDATE());
        END;

        INSERT INTO HistorialUbicaciones (usuario_id, asistencia_id, latitud, longitud, precision, estacion_id)
        VALUES (@usuarioId, @asistId, @lat, @lng, @acc, @estId);

        COMMIT TRANSACTION;

        SELECT * FROM @TempAsistencia;
      `);

    lastPings.delete(usuarioId);
    gpsImprecisos.delete(usuarioId);
    turnoCache.delete(usuarioId);
    const registro = sinFotos(registroResultado.recordset[0]);
    console.log(`🔔 [CHECK_IN] Usuario ${usuarioId} registró ENTRADA (similitud ${bio.sim}%).`);
    emitStaff('attendance_event', { tipo: 'CHECK_IN', usuarioId, asistencia: registro, geocerca: geo, fecha: new Date().toISOString() });

    res.json({ exito: true, asistencia: registro, geocerca: geo });
  } catch (err) {
    if (esTurnoDuplicado(err)) {
      return res.status(400).json({ error: 'Ya existe un turno activo para este trabajador' });
    }
    fail(res, err);
  }
});

app.post('/api/attendance/check-out', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { latitud, longitud, precision, fotoSalida, ticket } = req.body || {};
    const usuarioId = req.user.id;

    if (!validPhoto(fotoSalida)) {
      return res.status(400).json({ error: 'La foto de evidencia es OBLIGATORIA para registrar salida' });
    }
    const tieneCoords = latitud !== undefined && latitud !== null && longitud !== undefined && longitud !== null;
    if (tieneCoords && !validCoords(latitud, longitud)) {
      return res.status(400).json({ error: 'Coordenadas inválidas' });
    }

    const bio = consumeBioTicket(ticket, usuarioId, 'salida');
    if (!bio) {
      return res.status(403).json({ error: 'Verificación facial requerida o vencida. Repite el reconocimiento facial.' });
    }

    const p = await getPool();
    const resActivo = await p.request().input('usuarioId', sql.Int, usuarioId)
      .query("SELECT * FROM RegistroAsistencia WHERE usuario_id = @usuarioId AND estado = 'activo'");
    if (resActivo.recordset.length === 0) {
      return res.status(400).json({ error: 'No hay turno activo para registrar salida' });
    }

    const registroActivo = resActivo.recordset[0];
    const geo = tieneCoords ? await detectarEstacionTrabajo(latitud, longitud) : { estacionId: null, dentroDeEstacion: false };

    const resActualizacion = await p.request()
      .input('id', sql.Int, registroActivo.id)
      .input('usuarioId', sql.Int, usuarioId)
      .input('lat', sql.Float, tieneCoords ? latitud : null)
      .input('lng', sql.Float, tieneCoords ? longitud : null)
      .input('acc', sql.Float, optNum(precision))
      .input('estId', sql.Int, geo.estacionId)
      .input('foto', sql.NVarChar(sql.MAX), fotoSalida)
      .input('similitud', sql.Float, bio.sim)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;

        UPDATE RegistroAsistencia
        SET hora_salida = GETDATE(),
            latitud_salida = @lat, longitud_salida = @lng, precision_salida = @acc,
            estacion_salida_id = @estId, foto_salida_url = @foto,
            similitud_facial = COALESCE(@similitud, similitud_facial),
            verificacion_facial_exitosa = 1,
            estado = 'completado',
            horas_totales = ROUND(DATEDIFF(MINUTE, hora_ingreso, GETDATE()) / 60.0, 2)
        OUTPUT INSERTED.*
        WHERE id = @id;

        UPDATE UbicacionesEnVivo SET activo = 0, ultimo_ping = GETDATE() WHERE usuario_id = @usuarioId;
        ${almuerzoTabla ? "UPDATE AlmuerzosTurno SET fin_en = GETDATE(), cierre = 'salida' WHERE asistencia_id = @id AND fin_en IS NULL;" : ''}

        COMMIT TRANSACTION;
      `);

    lastPings.delete(usuarioId);
    gpsImprecisos.delete(usuarioId);
    turnoCache.delete(usuarioId);
    const registroCompletado = sinFotos(resActualizacion.recordset[0]);
    console.log(`🔔 [CHECK_OUT] Usuario ${usuarioId} registró SALIDA.`);
    emitStaff('attendance_event', { tipo: 'CHECK_OUT', usuarioId, asistencia: registroCompletado, fecha: new Date().toISOString() });

    res.json({ exito: true, mensaje: 'Salida registrada y rastreo GPS desactivado', asistencia: registroCompletado });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- ALMUERZO (dentro del turno; el GPS NO se detiene) -----------------
// Iniciar y terminar el almuerzo exigen verificación facial. Las horas del turno no se descuentan: solo se registra.
app.post('/api/attendance/lunch/start', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    if (almuerzoNoDisponible(res)) return;
    const { foto, ticket } = req.body || {};
    if (!validPhoto(foto)) return res.status(400).json({ error: 'La foto de evidencia es OBLIGATORIA para iniciar el almuerzo' });
    const usuarioId = req.user.id;

    const p = await getPool();
    const turno = await turnoActivoDe(p, usuarioId);
    if (!turno) return res.status(400).json({ error: 'No hay un turno activo', codigo: 'SIN_TURNO' });
    if (esOtroDispositivo(turno, dispositivoDe(req))) return res.status(409).json({ error: MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });

    const est = await p.request().input('a', sql.Int, turno.id)
      .query('SELECT COUNT(*) AS total, SUM(CASE WHEN fin_en IS NULL THEN 1 ELSE 0 END) AS abiertos FROM AlmuerzosTurno WHERE asistencia_id = @a');
    const { total, abiertos } = est.recordset[0];
    if (abiertos > 0) return res.status(400).json({ error: 'Ya está en su almuerzo', codigo: 'YA_EN_ALMUERZO' });
    if (total >= config.almuerzosPorTurno) {
      return res.status(400).json({ error: 'Ya registró su almuerzo en este turno', codigo: 'ALMUERZO_YA_USADO' });
    }

    const bio = consumeBioTicket(ticket, usuarioId, 'almuerzo_inicio');
    if (!bio) return res.status(403).json({ error: 'Verificación facial requerida o vencida. Repite el reconocimiento facial.' });

    // El GPS sigue su curso con normalidad; como lugar del almuerzo se toma la última ubicación conocida
    const ult = await p.request().input('u', sql.Int, usuarioId).input('aid', sql.Int, turno.id).query(
      'SELECT latitud, longitud FROM UbicacionesEnVivo WHERE usuario_id = @u AND asistencia_id = @aid');
    const pos = ult.recordset[0];
    const tienePos = Boolean(pos && validCoords(pos.latitud, pos.longitud));

    const r = await p.request()
      .input('a', sql.Int, turno.id)
      .input('u', sql.Int, usuarioId)
      .input('sim', sql.Float, bio.sim)
      .input('foto', sql.NVarChar(sql.MAX), foto)
      .input('lat', sql.Float, tienePos ? pos.latitud : null)
      .input('lng', sql.Float, tienePos ? pos.longitud : null)
      .query(`
        INSERT INTO AlmuerzosTurno (asistencia_id, usuario_id, similitud_inicio, foto_inicio_url, latitud_inicio, longitud_inicio)
        OUTPUT INSERTED.id, INSERTED.inicio_en
        VALUES (@a, @u, @sim, @foto, @lat, @lng)`);
    console.log(`🍽️ [ALMUERZO] Usuario ${usuarioId} inició su almuerzo (turno ${turno.id}).`);
    emitStaff('almuerzo_event', { tipo: 'INICIO', usuarioId, asistenciaId: turno.id, fecha: new Date().toISOString() });
    res.json({ exito: true, almuerzo: { id: r.recordset[0].id, permitidoMinutos: config.almuerzoMinutos } });
  } catch (err) {
    if (esTurnoDuplicado(err)) return res.status(400).json({ error: 'Ya está en su almuerzo', codigo: 'YA_EN_ALMUERZO' });
    fail(res, err);
  }
});

app.post('/api/attendance/lunch/end', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    if (almuerzoNoDisponible(res)) return;
    const { foto, ticket } = req.body || {};
    if (!validPhoto(foto)) return res.status(400).json({ error: 'La foto de evidencia es OBLIGATORIA para terminar el almuerzo' });
    const usuarioId = req.user.id;

    const p = await getPool();
    const turno = await turnoActivoDe(p, usuarioId);
    if (!turno) return res.status(400).json({ error: 'No hay un turno activo', codigo: 'SIN_TURNO' });
    if (esOtroDispositivo(turno, dispositivoDe(req))) return res.status(409).json({ error: MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });

    const abierto = await p.request().input('a', sql.Int, turno.id)
      .query('SELECT TOP 1 id FROM AlmuerzosTurno WHERE asistencia_id = @a AND fin_en IS NULL');
    if (!abierto.recordset.length) return res.status(400).json({ error: 'No está en su almuerzo', codigo: 'NO_EN_ALMUERZO' });

    const bio = consumeBioTicket(ticket, usuarioId, 'almuerzo_fin');
    if (!bio) return res.status(403).json({ error: 'Verificación facial requerida o vencida. Repite el reconocimiento facial.' });

    const ult = await p.request().input('u', sql.Int, usuarioId).input('aid', sql.Int, turno.id).query(
      'SELECT latitud, longitud FROM UbicacionesEnVivo WHERE usuario_id = @u AND asistencia_id = @aid');
    const pos = ult.recordset[0];
    const tienePos = Boolean(pos && validCoords(pos.latitud, pos.longitud));

    const r = await p.request()
      .input('id', sql.Int, abierto.recordset[0].id)
      .input('sim', sql.Float, bio.sim)
      .input('foto', sql.NVarChar(sql.MAX), foto)
      .input('lat', sql.Float, tienePos ? pos.latitud : null)
      .input('lng', sql.Float, tienePos ? pos.longitud : null)
      .query(`
        UPDATE AlmuerzosTurno
        SET fin_en = GETDATE(), similitud_fin = @sim, foto_fin_url = @foto, latitud_fin = @lat, longitud_fin = @lng, cierre = 'trabajador'
        OUTPUT DATEDIFF(SECOND, INSERTED.inicio_en, INSERTED.fin_en) AS segundos
        WHERE id = @id AND fin_en IS NULL`);
    if (!r.recordset.length) return res.status(409).json({ error: 'El almuerzo ya estaba cerrado' });

    const segundos = r.recordset[0].segundos;
    const minutos = Math.round(segundos / 60);
    console.log(`🍽️ [ALMUERZO] Usuario ${usuarioId} terminó su almuerzo (${minutos} min).`);
    emitStaff('almuerzo_event', { tipo: 'FIN', usuarioId, asistenciaId: turno.id, segundos, fecha: new Date().toISOString() });
    res.json({ exito: true, almuerzo: { segundos, minutos, permitidoMinutos: config.almuerzoMinutos, excedido: segundos > config.almuerzoMinutos * 60 } });
  } catch (err) {
    fail(res, err);
  }
});

// Salida forzada por un administrador: cierra el turno de un trabajador SIN verificación facial ni foto
// (olvidó marcar la salida, teléfono sin batería o perdido, falla de la app…). Queda registrada con quién, cuándo y por qué.
app.post('/api/attendance/:id/force-checkout', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });
    const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
    if (motivo.length < 3 || motivo.length > 200) {
      return res.status(400).json({ error: 'Indique el motivo de la salida forzada (entre 3 y 200 caracteres)' });
    }

    const p = await getPool();
    const turno = await p.request().input('id', sql.Int, id).query(`
      SELECT a.id, a.usuario_id, a.estado, u.nombre, u.codigo_empleado
      FROM RegistroAsistencia a JOIN Usuarios u ON u.id = a.usuario_id
      WHERE a.id = @id`);
    if (!turno.recordset.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const { usuario_id: usuarioId, estado, nombre, codigo_empleado: codigoTrabajador } = turno.recordset[0];
    if (estado !== 'activo') return res.status(409).json({ error: 'Este turno ya está cerrado' });

    const quien = await p.request().input('id', sql.Int, req.user.id)
      .query('SELECT nombre, codigo_empleado FROM Usuarios WHERE id = @id');
    const admin = quien.recordset[0] ? `${quien.recordset[0].codigo_empleado} ${quien.recordset[0].nombre}` : `usuario ${req.user.id}`;
    const nota = `SALIDA FORZADA por ${admin}: ${motivo}`.slice(0, 500);

    // Como ubicación de salida se usa la última conocida del trabajador (si hay)
    const ult = await p.request().input('u', sql.Int, usuarioId).input('aid', sql.Int, id).query(
      'SELECT latitud, longitud, precision FROM UbicacionesEnVivo WHERE usuario_id = @u AND asistencia_id = @aid');
    const pos = ult.recordset[0];
    const tienePos = Boolean(pos && validCoords(pos.latitud, pos.longitud));
    const geo = tienePos ? await detectarEstacionTrabajo(pos.latitud, pos.longitud) : { estacionId: null };

    const r = await p.request()
      .input('id', sql.Int, id)
      .input('usuarioId', sql.Int, usuarioId)
      .input('lat', sql.Float, tienePos ? pos.latitud : null)
      .input('lng', sql.Float, tienePos ? pos.longitud : null)
      .input('acc', sql.Float, tienePos ? optNum(pos.precision) : null)
      .input('estId', sql.Int, geo.estacionId)
      .input('nota', sql.NVarChar(500), nota)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;

        UPDATE RegistroAsistencia
        SET hora_salida = GETDATE(),
            latitud_salida = @lat, longitud_salida = @lng, precision_salida = @acc, estacion_salida_id = @estId,
            estado = 'completado',
            horas_totales = ROUND(DATEDIFF(MINUTE, hora_ingreso, GETDATE()) / 60.0, 2),
            notas = @nota
        OUTPUT INSERTED.*
        WHERE id = @id AND estado = 'activo';

        UPDATE UbicacionesEnVivo SET activo = 0, ultimo_ping = GETDATE() WHERE usuario_id = @usuarioId;
        ${almuerzoTabla ? "UPDATE AlmuerzosTurno SET fin_en = GETDATE(), cierre = 'administrador' WHERE asistencia_id = @id AND fin_en IS NULL;" : ''}

        COMMIT TRANSACTION;
      `);
    if (!r.recordset.length) return res.status(409).json({ error: 'Este turno ya está cerrado' });

    lastPings.delete(usuarioId);
    gpsImprecisos.delete(usuarioId);
    turnoCache.delete(usuarioId);
    const asistencia = sinFotos(r.recordset[0]);
    console.log(`🛑 [SALIDA FORZADA] ${admin} cerró el turno ${id} de ${codigoTrabajador} ${nombre}: ${motivo}`);
    emitStaff('attendance_event', { tipo: 'CHECK_OUT', forzada: true, usuarioId, asistencia, fecha: new Date().toISOString() });
    // Si el trabajador tiene la app abierta, se entera al instante (el servicio de GPS se detiene solo en su siguiente envío)
    io.to(`user:${usuarioId}`).emit('turno_cerrado', { forzada: true, fecha: new Date().toISOString() });

    res.json({ exito: true, trabajador: nombre, asistencia });
  } catch (err) {
    fail(res, err);
  }
});

// La app Android pide este token al marcar entrada y se lo entrega al servicio nativo de ubicación
app.post('/api/location/track-token', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const p = await getPool();
    const turno = await turnoActivoDe(p, req.user.id);
    if (!turno) {
      return res.status(403).json({ error: 'El rastreo solo está permitido durante un turno activo', codigo: 'SIN_TURNO' });
    }
    const dispositivo = dispositivoDe(req);
    if (esOtroDispositivo(turno, dispositivo)) {
      return res.status(409).json({ error: MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });
    }
    const asistenciaId = turno.id;
    const token = signToken({ typ: 'track', sub: req.user.id, aid: asistenciaId, did: dispositivo || '' }, config.trackTokenHours * 3600, jwtSecret);
    res.json({ token, asistenciaId, vigenciaHoras: config.trackTokenHours });
  } catch (err) {
    fail(res, err);
  }
});

// Recibe un LOTE de puntos GPS del servicio nativo. Cada punto trae su hora real de captura, así un punto
// guardado sin internet y enviado después queda en el momento correcto del recorrido.
// Alertas del supervisor que la app Android aún no mostró: viajan en la respuesta de cada lote (cada ~15 s).
// "ultima" es la última alerta que la app ya mostró; solo se entregan alertas sin leer y de los últimos 15 min.
async function alertasParaApp(p, usuarioId, ultima) {
  if (!pushTablasListas) return [];
  const r = await p.request().input('u', sql.Int, usuarioId).input('ultima', sql.Int, ultima)
    .query(`SELECT TOP 3 id, mensaje FROM AlertasEnviadas
            WHERE usuario_id = @u AND leida_en IS NULL AND id > @ultima AND enviada_en > DATEADD(MINUTE, -15, GETDATE())
            ORDER BY id ASC`);
  return r.recordset.map((a) => ({ id: a.id, mensaje: a.mensaje }));
}

const BATCH_MAX_PUNTOS = 200;
const BATCH_MAX_ANTIGUEDAD_MS = 12 * 3600 * 1000;
app.post('/api/location/batch', requireTrackAuth, async (req, res) => {
  try {
    const usuarioId = req.user.id;
    const puntos = req.body?.puntos;
    if (!Array.isArray(puntos) || puntos.length === 0 || puntos.length > BATCH_MAX_PUNTOS) {
      return res.status(400).json({ error: `Se esperan entre 1 y ${BATCH_MAX_PUNTOS} puntos` });
    }

    const ahora = Date.now();
    let invalidos = 0;
    let imprecisos = 0;
    let ultimaImprecision = null;
    const validos = [];
    for (const pt of puntos) {
      if (!pt || !validCoords(pt.latitud, pt.longitud) || !isNum(pt.precision) || pt.precision <= 0 || !isNum(pt.capturadoEn)) {
        invalidos++;
        continue;
      }
      if (pt.capturadoEn > ahora + 60_000 || ahora - pt.capturadoEn > BATCH_MAX_ANTIGUEDAD_MS) {
        invalidos++;
        continue;
      }
      if (pt.precision > config.gpsMaxPrecisionPing) {
        imprecisos++;
        ultimaImprecision = pt.precision;
        continue;
      }
      // Batería (opcional; las versiones anteriores de la app no la envían)
      pt.bat = Number.isInteger(pt.bateria) && pt.bateria >= 0 && pt.bateria <= 100 ? pt.bateria : null;
      pt.chg = typeof pt.cargando === 'boolean' ? (pt.cargando ? 1 : 0) : null;
      validos.push(pt);
    }
    validos.sort((a, b) => a.capturadoEn - b.capturadoEn);

    const p = await getPool();
    const turnoBatch = await turnoActivoDe(p, usuarioId);
    // Sin turno, o con un token de otro turno: el celular debe descartar su cola y detener el servicio
    if (!turnoBatch || turnoBatch.id !== req.trackAsistenciaId) {
      lastPings.delete(usuarioId);
      return res.status(403).json({ error: 'El turno de este rastreo ya no está activo', codigo: 'SIN_TURNO' });
    }
    // El turno pertenece a otro dispositivo: este celular debe dejar de rastrear (y descartar su cola)
    if (esOtroDispositivo(turnoBatch, req.trackDispositivo)) {
      return res.status(403).json({ error: MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });
    }
    const asistenciaId = turnoBatch.id;

    appNativaVista.set(usuarioId, Date.now());
    const ultimaAlerta = Number.isInteger(req.body?.ultimaAlerta) && req.body.ultimaAlerta >= 0 ? req.body.ultimaAlerta : 0;
    const alertas = await alertasParaApp(p, usuarioId, ultimaAlerta).catch(() => []);

    if (validos.length === 0) {
      if (imprecisos > 0) gpsImprecisos.set(usuarioId, { t: ahora, precision: ultimaImprecision });
      return res.json({ exito: true, guardados: 0, imprecisos, invalidos, omitidos: 0, alertas });
    }
    gpsImprecisos.delete(usuarioId);

    // Se descartan los casi idénticos al punto anterior (menos de 5 s y 10 m), igual que en /api/location/ping
    const previoServidor = lastPings.get(usuarioId);
    let ref = previoServidor ? { t: previoServidor.t, lat: previoServidor.lat, lng: previoServidor.lng } : null;
    const aGuardar = [];
    let omitidos = 0;
    for (const pt of validos) {
      if (
        ref &&
        Math.abs(pt.capturadoEn - ref.t) < PING_MIN_GAP_MS &&
        calcularDistanciaMetros(ref.lat, ref.lng, pt.latitud, pt.longitud) < PING_MIN_MOVE_METERS
      ) {
        omitidos++;
        continue;
      }
      aGuardar.push(pt);
      ref = { t: pt.capturadoEn, lat: pt.latitud, lng: pt.longitud };
    }

    // Estación de cada punto (las estaciones están en caché, no hay consulta por punto)
    for (const pt of aGuardar) pt.geo = await detectarEstacionTrabajo(pt.latitud, pt.longitud);

    const TAM = 50; // 50 puntos por consulta: sin acercarse al límite de parámetros de SQL Server
    for (let i = 0; i < aGuardar.length; i += TAM) {
      const trozo = aGuardar.slice(i, i + TAM);
      const rq = p.request().input('usuarioId', sql.Int, usuarioId).input('asistId', sql.Int, asistenciaId);
      const filas = trozo.map((pt, k) => {
        rq.input(`lat${k}`, sql.Float, pt.latitud)
          .input(`lng${k}`, sql.Float, pt.longitud)
          .input(`acc${k}`, sql.Float, pt.precision)
          .input(`est${k}`, sql.Int, pt.geo.estacionId)
          .input(`seg${k}`, sql.Int, Math.max(0, Math.round((ahora - pt.capturadoEn) / 1000)));
        if (bateriaColumnas) rq.input(`bat${k}`, sql.TinyInt, pt.bat).input(`chg${k}`, sql.Bit, pt.chg);
        return `(@usuarioId, @asistId, @lat${k}, @lng${k}, @acc${k}, @est${k}, DATEADD(SECOND, -@seg${k}, GETDATE())${
          bateriaColumnas ? `, @bat${k}, @chg${k}` : ''
        })`;
      });
      await rq.query(
        `INSERT INTO HistorialUbicaciones (usuario_id, asistencia_id, latitud, longitud, precision, estacion_id, fecha_registro${
          bateriaColumnas ? ', bateria, cargando' : ''
        }) VALUES ${filas.join(', ')}`
      );
    }

    // La ubicación "en vivo" es la del último punto, y solo si es más reciente que la que ya hay
    // (un lote atrasado no debe pisar un punto más nuevo enviado por la web)
    const ultimo = aGuardar[aGuardar.length - 1];
    if (ultimo) {
      await p.request()
        .input('usuarioId', sql.Int, usuarioId)
        .input('asistId', sql.Int, asistenciaId)
        .input('lat', sql.Float, ultimo.latitud)
        .input('lng', sql.Float, ultimo.longitud)
        .input('acc', sql.Float, ultimo.precision)
        .input('vel', sql.Float, optNum(ultimo.velocidad))
        .input('rumbo', sql.Float, optNum(ultimo.rumbo))
        .input('estId', sql.Int, ultimo.geo.estacionId)
        .input('dentro', sql.Bit, ultimo.geo.dentroDeEstacion ? 1 : 0)
        .input('seg', sql.Int, Math.max(0, Math.round((ahora - ultimo.capturadoEn) / 1000)))
        .input('bat', sql.TinyInt, ultimo.bat)
        .input('chg', sql.Bit, ultimo.chg)
        .query(`
          UPDATE UbicacionesEnVivo
          SET asistencia_id = @asistId, latitud = @lat, longitud = @lng, precision = @acc,
              velocidad = @vel, rumbo = @rumbo, estacion_actual_id = @estId,
              ${bateriaColumnas ? 'bateria = COALESCE(@bat, bateria), cargando = COALESCE(@chg, cargando),' : ''}
              dentro_de_estacion = @dentro, activo = 1, ultimo_ping = DATEADD(SECOND, -@seg, GETDATE())
          WHERE usuario_id = @usuarioId
            AND (ultimo_ping IS NULL OR ultimo_ping <= DATEADD(SECOND, -@seg, GETDATE()));
        `);

      lastPings.set(usuarioId, { t: ultimo.capturadoEn, lat: ultimo.latitud, lng: ultimo.longitud, geo: ultimo.geo });
      emitStaff('location_ping', {
        usuarioId,
        asistenciaId,
        latitud: ultimo.latitud,
        longitud: ultimo.longitud,
        precision: ultimo.precision,
        estacion: ultimo.geo.estacion,
        dentroDeEstacion: ultimo.geo.dentroDeEstacion,
        distanciaMetros: ultimo.geo.distanciaMetros,
        fecha: new Date(ultimo.capturadoEn).toISOString(),
        origen: 'app-android',
        bateria: ultimo.bat,
        cargando: ultimo.chg === null ? null : ultimo.chg === 1,
      });
    }

    res.json({ exito: true, guardados: aGuardar.length, omitidos, imprecisos, invalidos, geocerca: ultimo?.geo, alertas });
  } catch (err) {
    fail(res, err);
  }
});

// ----- Ubicación apagada / sin señal durante el turno -----
// Hora local del negocio, p. ej. "14:05"
const horaNegocio = (ms) =>
  new Intl.DateTimeFormat('es-PE', { timeZone: config.zonaHoraria, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const textoDuracion = (seg) => (seg < 90 ? `${Math.max(1, Math.round(seg))} s` : `${Math.round(seg / 60)} min`);
// usuarioId -> ms en que el celular avisó que el trabajador apagó la ubicación (se borra al volver a encenderla)
const gpsApagadoDesde = new Map();
const gpsEventosVistos = new Map(); // "usuario:tipo:t" -> ms (evita registrar dos veces un aviso reenviado)

// El servicio nativo avisa cuando el trabajador apaga o vuelve a encender la ubicación del celular. Cada aviso trae su
// hora real (puede llegar tarde si el celular estaba sin internet) y queda en la auditoría para el administrador.
const GPS_EVENTOS_MAX = 20;
app.post('/api/location/gps-evento', requireTrackAuth, async (req, res) => {
  try {
    const eventos = req.body?.eventos;
    if (!Array.isArray(eventos) || eventos.length === 0 || eventos.length > GPS_EVENTOS_MAX) {
      return res.status(400).json({ error: `Se esperan entre 1 y ${GPS_EVENTOS_MAX} eventos` });
    }
    const usuarioId = req.user.id;
    const p = await getPool();
    const turno = await turnoActivoDe(p, usuarioId);
    if (!turno || turno.id !== req.trackAsistenciaId) {
      return res.status(403).json({ error: 'El turno de este rastreo ya no está activo', codigo: 'SIN_TURNO' });
    }
    if (esOtroDispositivo(turno, req.trackDispositivo)) {
      return res.status(403).json({ error: MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });
    }
    appNativaVista.set(usuarioId, Date.now());

    const ahora = Date.now();
    const validos = eventos
      .filter((e) => e && (e.tipo === 'apagado' || e.tipo === 'encendido') && isNum(e.t) && e.t <= ahora + 60_000 && ahora - e.t <= BATCH_MAX_ANTIGUEDAD_MS)
      .sort((a, b) => a.t - b.t);
    for (const [k, t] of gpsEventosVistos) if (ahora - t > 24 * 3600 * 1000) gpsEventosVistos.delete(k);

    let registrados = 0;
    for (const ev of validos) {
      const clave = `${usuarioId}:${ev.tipo}:${Math.round(ev.t)}`;
      if (gpsEventosVistos.has(clave)) continue;
      const seg = Math.max(0, Math.round((ahora - ev.t) / 1000));
      let ok;
      if (ev.tipo === 'apagado') {
        ok = await registrarFraude({
          usuarioId,
          tipoEvento: 'GPS_APAGADO',
          similitud: 0,
          notas: `Apagó la ubicación del celular a las ${horaNegocio(ev.t)} durante el turno.`,
          segundosAtras: seg,
        });
        if (ok) gpsApagadoDesde.set(usuarioId, ev.t);
      } else {
        const desde = isNum(ev.desde) && ev.desde < ev.t ? ev.desde : null;
        ok = await registrarFraude({
          usuarioId,
          tipoEvento: 'GPS_REACTIVADO',
          similitud: 0,
          notas: desde
            ? `Volvió a activar la ubicación a las ${horaNegocio(ev.t)}. Estuvo apagada ${textoDuracion((ev.t - desde) / 1000)} (desde las ${horaNegocio(desde)}).`
            : `Volvió a activar la ubicación a las ${horaNegocio(ev.t)}.`,
          segundosAtras: seg,
        });
        if (ok) gpsApagadoDesde.delete(usuarioId);
      }
      // Si no se pudo guardar, el celular conserva el aviso y lo reintenta
      if (!ok) return res.status(500).json({ error: 'No se pudo registrar el evento' });
      gpsEventosVistos.set(clave, ahora);
      registrados++;
    }
    res.json({ exito: true, registrados });
  } catch (err) {
    fail(res, err);
  }
});

// Aviso al administrador cuando un trabajador en turno lleva SIN_SENAL_ALERTA_MIN minutos sin enviar ubicación
// (sin internet, app cerrada, celular apagado o ubicación apagada sin conexión). Una sola alerta por interrupción.
// Si el celular ya avisó que la ubicación está apagada, esa alerta ya existe y no se repite aquí.
async function revisarSinSenal() {
  const min = Math.round(config.sinSenalAlertaMin);
  if (!(min >= 2)) return;
  try {
    const p = await getPool();
    const r = await p.request().input('min', sql.Int, min).query(`
      SELECT a.usuario_id, x.desde, DATEDIFF(SECOND, x.desde, GETDATE()) AS seg
      FROM RegistroAsistencia a
      LEFT JOIN UbicacionesEnVivo uv ON uv.usuario_id = a.usuario_id
      CROSS APPLY (SELECT CASE WHEN uv.ultimo_ping > a.hora_ingreso THEN uv.ultimo_ping ELSE a.hora_ingreso END AS desde) x
      WHERE a.estado = 'activo'
        AND x.desde < DATEADD(MINUTE, -@min, GETDATE())
        AND NOT EXISTS (
          SELECT 1 FROM AuditoriaFraudeFacial f
          WHERE f.usuario_id = a.usuario_id AND f.tipo_evento = 'SIN_SENAL_GPS' AND f.fecha_intento >= x.desde
        )
    `);
    for (const fila of r.recordset) {
      const apagado = gpsApagadoDesde.get(fila.usuario_id);
      const inicio = Date.now() - fila.seg * 1000;
      if (apagado && apagado >= inicio - 120_000) continue; // ya se avisó: apagó la ubicación
      await registrarFraude({
        usuarioId: fila.usuario_id,
        tipoEvento: 'SIN_SENAL_GPS',
        similitud: 0,
        notas: `Sin recibir ubicación desde las ${horaNegocio(inicio)} (${textoDuracion(fila.seg)}). Posibles causas: sin internet, app cerrada, celular apagado o ubicación apagada sin conexión.`,
      });
    }
    for (const [uid, t] of gpsApagadoDesde) if (Date.now() - t > 24 * 3600 * 1000) gpsApagadoDesde.delete(uid);
  } catch (err) {
    console.error('Error al revisar trabajadores sin señal:', err.message);
  }
}
if (config.sinSenalAlertaMin > 0 && config.sinSenalAlertaMin < 2) {
  console.warn('⚠️ SIN_SENAL_ALERTA_MIN debe ser al menos 2 minutos; el aviso de falta de señal queda desactivado.');
}
if (config.sinSenalAlertaMin >= 2) setInterval(revisarSinSenal, 60 * 1000).unref();

app.post('/api/location/ping', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { latitud, longitud, precision, velocidad, rumbo, antiguedadMs } = req.body || {};
    const usuarioId = req.user.id;
    if (!validCoords(latitud, longitud) || !isNum(precision)) return res.status(400).json({ error: 'Parámetros incompletos' });

    // Solo el dispositivo que marcó la entrada puede enviar la ubicación del turno (evita mezclar dos celulares)
    const turnoPing = await turnoActivoDe(await getPool(), usuarioId);
    if (esOtroDispositivo(turnoPing, dispositivoDe(req))) {
      return res.status(409).json({ error: MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });
    }

    // Un punto impreciso (o viejo) no se guarda: dejaría al trabajador "ubicado" donde no está
    if (precision > config.gpsMaxPrecisionPing || (isNum(antiguedadMs) && antiguedadMs > config.gpsMaxAgeMs)) {
      gpsImprecisos.set(usuarioId, { t: Date.now(), precision });
      return res.json({
        exito: true,
        omitido: true,
        imprecisa: true,
        precision: Math.round(precision),
        maxima: config.gpsMaxPrecisionPing,
        geocerca: lastPings.get(usuarioId)?.geo,
      });
    }
    gpsImprecisos.delete(usuarioId);

    // Punto demasiado reciente y casi en el mismo lugar: no se guarda (responde con el último resultado)
    const previo = lastPings.get(usuarioId);
    if (
      previo &&
      Date.now() - previo.t < PING_MIN_GAP_MS &&
      calcularDistanciaMetros(previo.lat, previo.lng, latitud, longitud) < PING_MIN_MOVE_METERS
    ) {
      return res.json({ exito: true, omitido: true, geocerca: previo.geo });
    }

    const p = await getPool();
    const resActivo = await p.request().input('usuarioId', sql.Int, usuarioId)
      .query("SELECT id FROM RegistroAsistencia WHERE usuario_id = @usuarioId AND estado = 'activo'");
    if (resActivo.recordset.length === 0) {
      lastPings.delete(usuarioId);
      return res.status(403).json({ error: 'El rastreo solo está permitido durante un turno activo' });
    }

    const asistenciaId = resActivo.recordset[0].id;
    const geo = await detectarEstacionTrabajo(latitud, longitud);

    await p.request()
      .input('usuarioId', sql.Int, usuarioId)
      .input('asistId', sql.Int, asistenciaId)
      .input('lat', sql.Float, latitud)
      .input('lng', sql.Float, longitud)
      .input('acc', sql.Float, optNum(precision))
      .input('vel', sql.Float, optNum(velocidad))
      .input('rumbo', sql.Float, optNum(rumbo))
      .input('estId', sql.Int, geo.estacionId)
      .input('dentro', sql.Bit, geo.dentroDeEstacion ? 1 : 0)
      .query(`
        UPDATE UbicacionesEnVivo
        SET asistencia_id = @asistId, latitud = @lat, longitud = @lng, precision = @acc,
            velocidad = @vel, rumbo = @rumbo, estacion_actual_id = @estId,
            dentro_de_estacion = @dentro, activo = 1, ultimo_ping = GETDATE()
        WHERE usuario_id = @usuarioId;

        INSERT INTO HistorialUbicaciones (usuario_id, asistencia_id, latitud, longitud, precision, estacion_id)
        VALUES (@usuarioId, @asistId, @lat, @lng, @acc, @estId);
      `);

    lastPings.set(usuarioId, { t: Date.now(), lat: latitud, lng: longitud, geo });

    emitStaff('location_ping', {
      usuarioId,
      asistenciaId,
      latitud,
      longitud,
      precision: optNum(precision),
      estacion: geo.estacion,
      dentroDeEstacion: geo.dentroDeEstacion,
      distanciaMetros: geo.distanciaMetros,
      fecha: new Date().toISOString(),
    });

    res.json({ exito: true, geocerca: geo });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- HISTORIALES (administración) -----------------

app.get('/api/attendance/logs', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    // Filtros: desde/hasta (fecha-hora ISO; "hasta" excluyente), q (nombre o código), limit/offset (paginación)
    const parseFecha = (v) => {
      if (v === undefined || v === '') return null;
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const desde = parseFecha(req.query.desde);
    const hasta = parseFecha(req.query.hasta);
    if (desde === undefined || hasta === undefined) return res.status(400).json({ error: 'Fecha inválida' });

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 1000);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const qLike = q ? `%${q.replace(/[\[\]%_]/g, (c) => `[${c}]`)}%` : null; // escapa los comodines de LIKE

    // proyecto: solo asistencias cuya estación de ingreso pertenece a ese proyecto
    const proyecto = proyectosHabilitados ? Number.parseInt(req.query.proyecto, 10) || null : null;

    const filtro = `
      WHERE (@desde IS NULL OR a.hora_ingreso >= @desde)
        AND (@hasta IS NULL OR a.hora_ingreso < @hasta)
        AND (@q IS NULL OR u.nombre LIKE @q OR u.codigo_empleado LIKE @q)
        ${proyecto ? 'AND eIng.proyecto_id = @proyecto' : ''}`;
    const bind = (r) => {
      r.input('desde', sql.DateTime2, desde).input('hasta', sql.DateTime2, hasta).input('q', sql.NVarChar(120), qLike);
      if (proyecto) r.input('proyecto', sql.Int, proyecto);
      return r;
    };

    const p = await getPool();
    const total = await bind(p.request()).query(
      `SELECT COUNT(*) AS total FROM RegistroAsistencia a JOIN Usuarios u ON a.usuario_id = u.id
         LEFT JOIN EstacionesTrabajo eIng ON a.estacion_ingreso_id = eIng.id ${filtro}`
    );
    const result = await bind(p.request()).input('offset', sql.Int, offset).input('limit', sql.Int, limit).query(`
      SELECT
        a.id, a.usuario_id, u.nombre as nombre_usuario, u.codigo_empleado, u.cargo,
        ISNULL(DATALENGTH(u.foto_referencia_url), 0) AS foto_ref_bytes,
        a.hora_ingreso, a.hora_salida, a.latitud_ingreso, a.longitud_ingreso, a.latitud_salida, a.longitud_salida,
        CASE WHEN a.foto_ingreso_url IS NULL THEN 0 ELSE 1 END AS tiene_foto_ingreso,
        CASE WHEN a.foto_salida_url IS NULL THEN 0 ELSE 1 END AS tiene_foto_salida,
        a.similitud_facial, a.verificacion_facial_exitosa,
        a.metodo_validacion, a.estado, a.horas_totales, a.notas,
        ${almuerzoTabla ? 'alm.id AS almuerzo_id, alm.inicio_en AS almuerzo_inicio, alm.fin_en AS almuerzo_fin,' : ''}
        ${proyectosHabilitados ? '(SELECT pr.nombre FROM Proyectos pr WHERE pr.id = eIng.proyecto_id) AS proyecto_nombre,' : ''}
        eIng.nombre as estacion_ingreso_nombre, eSal.nombre as estacion_salida_nombre
      FROM RegistroAsistencia a
      JOIN Usuarios u ON a.usuario_id = u.id
      LEFT JOIN EstacionesTrabajo eIng ON a.estacion_ingreso_id = eIng.id
      LEFT JOIN EstacionesTrabajo eSal ON a.estacion_salida_id = eSal.id
      ${almuerzoTabla ? 'OUTER APPLY (SELECT TOP 1 x.id, x.inicio_en, x.fin_en FROM AlmuerzosTurno x WHERE x.asistencia_id = a.id ORDER BY x.id DESC) alm' : ''}
      ${filtro}
      ORDER BY a.hora_ingreso DESC, a.id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);
    res.setHeader('X-Total-Count', String(total.recordset[0].total));
    res.json(result.recordset);
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/attendance/fraud-logs', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
    const p = await getPool();
    const result = await p.request().input('limit', sql.Int, limit).query(`
      SELECT TOP (@limit)
        f.id, f.usuario_id, u.nombre as nombre_usuario, u.codigo_empleado, u.cargo,
        f.fecha_intento, f.tipo_evento, CASE WHEN f.foto_intento_url IS NULL THEN 0 ELSE 1 END AS tiene_foto_intento,
        f.similitud_obtenida, f.latitud, f.longitud, f.notas
      FROM AuditoriaFraudeFacial f
      JOIN Usuarios u ON f.usuario_id = u.id
      ORDER BY f.fecha_intento DESC;
    `);
    res.json(result.recordset);
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- NOTIFICACIONES PUSH / ALERTAS -----------------

const MENSAJE_ALERTA_DEFECTO = 'Se encuentra fuera de su zona de trabajo. Regrese a su estación asignada.';
const lastAlertas = new Map(); // usuarioId -> instante de la última alerta (evita el envío repetido por error)

function pushDisponible(res) {
  if (!pushConfigurado) {
    res.status(503).json({ error: 'Las notificaciones no están configuradas en el servidor (faltan las claves VAPID).' });
    return false;
  }
  if (!pushTablasListas) {
    res.status(503).json({ error: 'Falta preparar la base de datos para las notificaciones: ejecuta  npm run migrate-push' });
    return false;
  }
  return true;
}

// El celular consulta la precisión GPS que se le exige
app.get('/api/gps/config', requireAuth(), (req, res) => {
  res.json({
    maxPrecisionCheckin: config.gpsMaxPrecisionCheckin,
    maxPrecisionPing: config.gpsMaxPrecisionPing,
    maxAgeMs: config.gpsMaxAgeMs,
  });
});

// El celular consulta si el servidor admite notificaciones y obtiene la clave pública para suscribirse
app.get('/api/push/config', requireAuth(), (req, res) => {
  const habilitado = pushConfigurado && pushTablasListas;
  res.json({ habilitado, publicKey: habilitado ? config.vapidPublicKey : null });
});

// El celular registra (o actualiza) su suscripción. Es idempotente: se puede llamar en cada inicio de sesión.
app.post('/api/push/subscribe', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    if (!pushDisponible(res)) return;
    const sub = req.body?.subscription;
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const authKey = sub?.keys?.auth;
    const ok =
      typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 450 &&
      typeof p256dh === 'string' && p256dh.length > 0 && p256dh.length <= 200 &&
      typeof authKey === 'string' && authKey.length > 0 && authKey.length <= 100;
    if (!ok) return res.status(400).json({ error: 'Suscripción inválida' });

    const userAgent = typeof req.body?.userAgent === 'string' ? req.body.userAgent.slice(0, 300) : null;
    const p = await getPool();
    // Si el mismo dispositivo cambia de trabajador (celular compartido), la suscripción pasa al nuevo usuario
    await p.request()
      .input('u', sql.Int, req.user.id)
      .input('endpoint', sql.NVarChar(450), endpoint)
      .input('p256dh', sql.NVarChar(200), p256dh)
      .input('auth', sql.NVarChar(100), authKey)
      .input('ua', sql.NVarChar(300), userAgent)
      .query(`
        MERGE SuscripcionesPush AS t
        USING (SELECT @endpoint AS endpoint) AS s ON t.endpoint = s.endpoint
        WHEN MATCHED THEN UPDATE SET usuario_id = @u, p256dh = @p256dh, auth = @auth, user_agent = @ua
        WHEN NOT MATCHED THEN INSERT (usuario_id, endpoint, p256dh, auth, user_agent) VALUES (@u, @endpoint, @p256dh, @auth, @ua);

        -- como máximo 5 dispositivos por trabajador: se conservan los más recientes
        DELETE FROM SuscripcionesPush
         WHERE usuario_id = @u AND id NOT IN (SELECT TOP 5 id FROM SuscripcionesPush WHERE usuario_id = @u ORDER BY id DESC);
      `);
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/push/unsubscribe', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    if (!pushDisponible(res)) return;
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 450) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    await p.request().input('u', sql.Int, req.user.id).input('endpoint', sql.NVarChar(450), endpoint)
      .query('DELETE FROM SuscripcionesPush WHERE usuario_id = @u AND endpoint = @endpoint');
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// Un administrador/supervisor envía una alerta a un trabajador
app.post('/api/push/send', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    if (!pushDisponible(res)) return;
    const usuarioId = Number.parseInt(req.body?.usuarioId, 10);
    if (!Number.isInteger(usuarioId)) return res.status(400).json({ error: 'Trabajador inválido' });

    const mensaje = (typeof req.body?.mensaje === 'string' ? req.body.mensaje.trim() : '') || MENSAJE_ALERTA_DEFECTO;
    if (mensaje.length > 200) return res.status(400).json({ error: 'El mensaje no puede pasar de 200 caracteres' });

    const p = await getPool();
    const u = await p.request().input('id', sql.Int, usuarioId)
      .query("SELECT id, nombre FROM Usuarios WHERE id = @id AND rol = 'trabajador' AND activo = 1");
    if (!u.recordset.length) return res.status(404).json({ error: 'Trabajador no encontrado' });

    const previa = lastAlertas.get(usuarioId);
    if (previa && Date.now() - previa < 15_000) {
      return res.status(429).json({ error: 'Acabas de enviar una alerta a este trabajador. Espera unos segundos.' });
    }
    lastAlertas.set(usuarioId, Date.now());

    // Auditoría: queda registrada aunque el celular no la reciba
    const reg = await p.request()
      .input('u', sql.Int, usuarioId).input('por', sql.Int, req.user.id).input('m', sql.NVarChar(300), mensaje)
      .query('INSERT INTO AlertasEnviadas (usuario_id, enviado_por, mensaje) OUTPUT INSERTED.id VALUES (@u, @por, @m)');
    const alertaId = reg.recordset[0].id;

    const subs = (await p.request().input('u', sql.Int, usuarioId)
      .query('SELECT id, endpoint, p256dh, auth FROM SuscripcionesPush WHERE usuario_id = @u')).recordset;

    const payload = JSON.stringify({
      title: `Alerta de ${config.marcaNombre}`,
      body: mensaje,
      tag: 'smi-alerta',
      alertaId,
      url: `/?alerta=${alertaId}`,
    });

    // urgency "high" + TTL de 1 hora: el sistema del celular la entrega aunque esté en reposo
    const resultados = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 3600,
          urgency: 'high',
          timeout: 8000,
        })
      )
    );

    let exitosos = 0;
    const caducadas = [];
    resultados.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        exitosos += 1;
      } else if (r.reason?.statusCode === 404 || r.reason?.statusCode === 410) {
        caducadas.push(subs[i].id); // el celular ya no está suscrito (desinstaló la app o revocó el permiso)
      } else {
        console.warn(`Alerta ${alertaId}: fallo al enviar a un dispositivo (${r.reason?.statusCode || r.reason?.message})`);
      }
    });

    for (const id of caducadas) {
      await p.request().input('id', sql.Int, id).query('DELETE FROM SuscripcionesPush WHERE id = @id');
    }
    await p.request().input('id', sql.Int, alertaId).input('d', sql.Int, subs.length).input('e', sql.Int, exitosos)
      .query('UPDATE AlertasEnviadas SET dispositivos = @d, exitosos = @e WHERE id = @id');

    // Si el trabajador tiene la app abierta, además se le avisa al instante dentro de la app
    io.to(`user:${usuarioId}`).emit('alerta', { id: alertaId, mensaje, fecha: new Date().toISOString() });
    const enApp = (await io.in(`user:${usuarioId}`).fetchSockets()).length > 0;

    console.log(`🔔 [ALERTA ${alertaId}] ${req.user.id} -> usuario ${usuarioId}: ${exitosos}/${subs.length} dispositivos, app abierta: ${enApp}, app Android: ${appNativaActiva(usuarioId)}`);
    res.json({
      alertaId,
      trabajador: u.recordset[0].nombre,
      dispositivos: subs.length,
      entregadosAlServicioPush: exitosos,
      caducados: caducadas.length,
      appAbierta: enApp,
      appNativa: appNativaActiva(usuarioId),
    });
  } catch (err) {
    fail(res, err);
  }
});

// El trabajador abrió/leyó la alerta: se registra y se avisa a los administradores
app.post('/api/push/alertas/:id/leida', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    if (!pushDisponible(res)) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id).input('u', sql.Int, req.user.id)
      .query('UPDATE AlertasEnviadas SET leida_en = GETDATE() WHERE id = @id AND usuario_id = @u AND leida_en IS NULL');
    if (r.rowsAffected[0]) {
      emitStaff('alerta_leida', { alertaId: id, usuarioId: req.user.id, fecha: new Date().toISOString() });
    }
    res.json({ exito: true });
  } catch (err) {
    fail(res, err);
  }
});

// Recorrido de un turno: todos los puntos GPS guardados entre la entrada y la salida (o hasta ahora, si sigue activo)
app.get('/api/attendance/:id/route', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Solicitud inválida' });

    const p = await getPool();
    const turno = await p.request().input('id', sql.Int, id).query(`
      SELECT a.id, a.usuario_id, u.nombre AS nombre_usuario, u.codigo_empleado, u.cargo,
             a.hora_ingreso, a.hora_salida, a.estado,
             a.latitud_ingreso, a.longitud_ingreso, a.latitud_salida, a.longitud_salida
      FROM RegistroAsistencia a JOIN Usuarios u ON u.id = a.usuario_id
      WHERE a.id = @id`);
    if (!turno.recordset.length) return res.status(404).json({ error: 'Turno no encontrado' });

    // Un turno de 8 h a un punto cada 15 s son ~1 900 puntos; el tope evita respuestas enormes ante datos anómalos
    const puntos = await p.request().input('id', sql.Int, id).query(`
      SELECT TOP (20000) latitud, longitud, precision, estacion_id, fecha_registro${bateriaColumnas ? ', bateria, cargando' : ''}
      FROM HistorialUbicaciones
      WHERE asistencia_id = @id
      ORDER BY fecha_registro ASC, id ASC`);
    const reloj = await p.request().query('SELECT GETDATE() AS ahora');

    let almuerzos = [];
    if (almuerzoTabla) {
      const al = await p.request().input('id', sql.Int, id).query(`
        SELECT id, inicio_en, fin_en, cierre,
               CASE WHEN foto_inicio_url IS NULL THEN 0 ELSE 1 END AS foto_inicio,
               CASE WHEN foto_fin_url IS NULL THEN 0 ELSE 1 END AS foto_fin
        FROM AlmuerzosTurno WHERE asistencia_id = @id ORDER BY id ASC`);
      almuerzos = al.recordset;
    }

    res.json({
      ahora: reloj.recordset[0].ahora,
      almuerzoMinutos: config.almuerzoMinutos,
      almuerzos,
      asistencia: turno.recordset[0],
      puntos: puntos.recordset.map((r) => ({
        lat: r.latitud,
        lng: r.longitud,
        precision: r.precision,
        estacionId: r.estacion_id,
        fecha: r.fecha_registro,
        bateria: r.bateria ?? null,
        cargando: r.cargando === null || r.cargando === undefined ? null : Boolean(r.cargando),
      })),
    });
  } catch (err) {
    fail(res, err);
  }
});

// ----------------- FOTOS BAJO DEMANDA (administración) -----------------
// Las listas ya no incluyen las fotos: el panel las pide una por una, solo cuando se ven.

const idParam = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

app.get('/api/photos/lunch/:id/:kind', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    if (!almuerzoTabla) return res.status(404).json({ error: 'Foto no disponible' });
    const id = idParam(req.params.id);
    const columna = { in: 'foto_inicio_url', out: 'foto_fin_url' }[req.params.kind];
    if (!id || !columna) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id).query(`SELECT ${columna} AS foto FROM AlmuerzosTurno WHERE id = @id`);
    enviarFoto(res, r.recordset[0]?.foto);
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/photos/attendance/:id/:kind', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const id = idParam(req.params.id);
    const columna = { in: 'foto_ingreso_url', out: 'foto_salida_url' }[req.params.kind];
    if (!id || !columna) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id).query(`SELECT ${columna} AS foto FROM RegistroAsistencia WHERE id = @id`);
    enviarFoto(res, r.recordset[0]?.foto);
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/photos/user/:id/reference', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id).query('SELECT foto_referencia_url AS foto FROM Usuarios WHERE id = @id');
    enviarFoto(res, r.recordset[0]?.foto);
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/photos/fraud/:id', requireAuth(ROLES_STAFF), async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Solicitud inválida' });
    const p = await getPool();
    const r = await p.request().input('id', sql.Int, id).query('SELECT foto_intento_url AS foto FROM AuditoriaFraudeFacial WHERE id = @id');
    enviarFoto(res, r.recordset[0]?.foto);
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// WebSocket: solo sesiones válidas; los eventos van únicamente a administradores/supervisores
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth?.token, jwtSecret);
  if (!payload || payload.typ !== 'session') return next(new Error('No autorizado'));
  socket.data.user = { id: payload.sub, rol: payload.rol };
  next();
});

io.on('connection', (socket) => {
  if (ROLES_STAFF.includes(socket.data.user.rol)) socket.join('staff');
  socket.join(`user:${socket.data.user.id}`);
  console.log(`🔌 Socket conectado (usuario ${socket.data.user.id}, ${socket.data.user.rol})`);
  socket.on('disconnect', () => {
    console.log(`🔌 Socket desconectado (usuario ${socket.data.user.id})`);
  });
});

// ---------------------------------------------------------------------------
// Frontend compilado (producción): el mismo servidor entrega la app web/PWA
// ---------------------------------------------------------------------------
const distDir = path.resolve(__dirname, '../client/dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        const base = path.basename(filePath);
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // archivos con hash
        } else if (/^(sw\.js|push-sw\.js|workbox-.*\.js|index\.html|manifest\.webmanifest|registerSW\.js)$/.test(base)) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    })
  );
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log('📦 Sirviendo el frontend compilado desde client/dist');
}

// Rutas API inexistentes y errores generales (JSON mal formado, cuerpo demasiado grande…)
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud es demasiado grande' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error('Error no controlado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Retención opcional del historial de puntos GPS. Solo actúa si RETENCION_UBICACIONES_DIAS está definida (> 0).
// Borra en lotes pequeños para no bloquear la base. Por defecto NO borra nada.
const retencionDias = Number(process.env.RETENCION_UBICACIONES_DIAS || 0);
async function purgarHistorialUbicaciones() {
  if (!(retencionDias >= 7)) return; // mínimo 7 días: evita borrar de más por una configuración equivocada
  try {
    const p = await getPool();
    let total = 0;
    for (;;) {
      const r = await p.request().input('dias', sql.Int, retencionDias).query(
        'DELETE TOP (5000) FROM HistorialUbicaciones WHERE fecha_registro < DATEADD(DAY, -@dias, GETDATE())'
      );
      const borradas = r.rowsAffected[0] || 0;
      total += borradas;
      if (borradas < 5000) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (total) console.log(`🧹 Retención: ${total} puntos GPS de más de ${retencionDias} días eliminados.`);
  } catch (err) {
    console.error('Error en la retención de puntos GPS:', err.message);
  }
}
if (retencionDias > 0) {
  if (retencionDias < 7) console.warn('⚠️ RETENCION_UBICACIONES_DIAS debe ser al menos 7; la retención queda desactivada.');
  setTimeout(purgarHistorialUbicaciones, 2 * 60 * 1000).unref();
  setInterval(purgarHistorialUbicaciones, 24 * 60 * 60 * 1000).unref();
}

// Retención de fotos y registros (RETENCION_FOTOS_DIAS / RETENCION_REGISTROS_DIAS), una vez al día
async function purgarDatosVencidos() {
  try {
    const p = await getPool();
    const r = await purgarVencidos(p, { fotosDias: config.retencionFotosDias, registrosDias: config.retencionRegistrosDias });
    const total = Object.values(r).reduce((a, b) => a + b, 0);
    if (total) console.log(`🧹 Retención de datos personales: ${JSON.stringify(r)}`);
  } catch (err) {
    console.error('Error en la retención de fotos y registros:', err.message);
  }
}
for (const [nombre, dias] of [['RETENCION_FOTOS_DIAS', config.retencionFotosDias], ['RETENCION_REGISTROS_DIAS', config.retencionRegistrosDias]]) {
  if (dias > 0 && dias < MINIMO_DIAS) console.warn(`⚠️ ${nombre} debe ser al menos ${MINIMO_DIAS} días; esa retención queda desactivada.`);
}
if (config.retencionFotosDias >= MINIMO_DIAS || config.retencionRegistrosDias >= MINIMO_DIAS) {
  setTimeout(purgarDatosVencidos, 3 * 60 * 1000).unref();
  setInterval(purgarDatosVencidos, 24 * 60 * 60 * 1000).unref();
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🚀 Servidor ${config.marcaNombre} Asistencia & GPS corriendo en ${useTls ? 'https' : 'http'}://0.0.0.0:${config.port} (${isProduction ? 'producción' : 'desarrollo'})`);
  if (isProduction && !useTls && !config.trustProxy) {
    console.warn('⚠️ Producción sin HTTPS: la cámara y el GPS del celular exigen HTTPS (usa SSL_KEY_PATH/SSL_CERT_PATH o un proxy inverso con TRUST_PROXY=1).');
  }
  checkPinColumn();
  checkPushTables();
  checkDispositivoColumna();
  checkBateriaColumnas();
  checkAlmuerzoTabla();
  checkCalendarioTablas();
  checkPrivacidadTabla();
  checkDniColumna();
  checkProyectos();
});
