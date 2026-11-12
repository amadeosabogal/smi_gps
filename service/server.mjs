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

// Emitir solo a administradores/supervisores conectados
const emitStaff = (event, payload) => io.to('staff').emit(event, payload);

// ---------------------------------------------------------------------------
// Autenticación
// ---------------------------------------------------------------------------
const loginIpLimiter = createLimiter({ max: config.loginIpMax, windowMs: 10 * 60 * 1000 });
const loginUserLimiter = createLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const faceFailLimiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

function requireAuth(roles) {
  return (req, res, next) => {
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
    next();
  };
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

async function doLogin(req, res, { findUser, allowedRoles, ttlHours, secretValue, label }) {
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
  const token = signToken({ typ: 'session', sub: user.id, rol: user.rol }, ttlHours * 3600, jwtSecret);
  return res.json({ token, user: publicUser(user) });
}

// ----------------- RUTAS PÚBLICAS -----------------

app.get('/api/health', (req, res) => {
  res.json({ estado: 'ok', fecha: new Date().toISOString() });
});

// Lista mínima para la pantalla de ingreso del trabajador (sin datos sensibles)
app.get('/api/public/workers', async (req, res) => {
  try {
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
    const { usuarioId, pin } = req.body || {};
    const id = Number.parseInt(usuarioId, 10);
    await doLogin(req, res, {
      label: 'worker',
      secretValue: typeof pin === 'string' ? pin : String(pin ?? ''),
      allowedRoles: ROLES_WORKER,
      ttlHours: config.sessionHours,
      findUser: async () => {
        if (!Number.isInteger(id)) return null;
        const p = await getPool();
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
    const result = await p.request().query('SELECT * FROM EstacionesTrabajo ORDER BY id ASC');
    res.json(result.recordset);
  } catch (err) {
    fail(res, err);
  }
});

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
    const result = await p.request()
      .input('codigo', sql.VarChar(50), String(codigo).slice(0, 50))
      .input('nombre', sql.NVarChar(150), String(nombre).slice(0, 150))
      .input('latitud', sql.Float, latitud)
      .input('longitud', sql.Float, longitud)
      .input('radio', sql.Float, radio)
      .input('color', sql.VarChar(20), String(color || '#3B82F6').slice(0, 20))
      .input('descripcion', sql.NVarChar(255), String(descripcion || '').slice(0, 255))
      .query(`
        INSERT INTO EstacionesTrabajo (codigo, nombre, latitud, longitud, radio_metros, color, descripcion)
        OUTPUT INSERTED.*
        VALUES (@codigo, @nombre, @latitud, @longitud, @radio, @color, @descripcion);
      `);

    const nuevaEstacion = result.recordset[0];
    estacionesCache = null; // la próxima consulta vuelve a leer las estaciones
    io.emit('workstations_updated', nuevaEstacion);
    res.status(201).json(nuevaEstacion);
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
    const result = await p.request().query(
      `SELECT id, codigo_empleado, nombre, correo, rol, cargo, telefono, activo, facial_enrolado,
              ISNULL(DATALENGTH(foto_referencia_url), 0) AS foto_ref_bytes
         FROM Usuarios`
    );
    res.json(result.recordset);
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/users', requireAuth(ROLES_ADMIN), async (req, res) => {
  try {
    const { codigo_empleado, nombre, correo, cargo, telefono, pin } = req.body || {};

    if (!codigo_empleado || !nombre) {
      return res.status(400).json({ error: 'Código de empleado y nombre son obligatorios' });
    }
    if (pin !== undefined && pin !== null && pin !== '' && !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: 'El PIN debe tener entre 4 y 6 dígitos' });
    }
    if (!pinColumnWide) {
      return res.status(500).json({ error: 'Falta migrar la base de datos: ejecuta  node service/migrate-security.mjs' });
    }

    const p = await getPool();
    const existe = await p.request().input('codigo', sql.VarChar(50), String(codigo_empleado)).query('SELECT id FROM Usuarios WHERE codigo_empleado = @codigo');
    if (existe.recordset.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario con este código de empleado' });
    }

    const email = correo || `${String(codigo_empleado).toLowerCase()}@smi.pe`;
    // Si no se indica PIN, se genera uno aleatorio y se muestra UNA sola vez
    const pinInicial = pin ? String(pin) : String(crypto.randomInt(100000, 999999));

    const result = await p.request()
      .input('codigo', sql.VarChar(50), String(codigo_empleado).slice(0, 50))
      .input('nombre', sql.NVarChar(150), String(nombre).slice(0, 150))
      .input('correo', sql.VarChar(150), String(email).slice(0, 150))
      .input('pin', sql.VarChar(200), await hashPinAsync(pinInicial))
      .input('cargo', sql.NVarChar(100), String(cargo || 'Operador de Campo').slice(0, 100))
      .input('telefono', sql.VarChar(30), String(telefono || '').slice(0, 30))
      .query(`
        INSERT INTO Usuarios (codigo_empleado, nombre, correo, pin, rol, cargo, telefono, activo, facial_enrolado, creado_en)
        OUTPUT INSERTED.id, INSERTED.codigo_empleado, INSERTED.nombre, INSERTED.correo, INSERTED.rol, INSERTED.cargo,
               INSERTED.telefono, INSERTED.activo, INSERTED.facial_enrolado
        VALUES (@codigo, @nombre, @correo, @pin, 'trabajador', @cargo, @telefono, 1, 0, GETDATE());
      `);

    const nuevoUsuario = result.recordset[0];
    emitStaff('user_created', nuevoUsuario);
    res.status(201).json({ ...nuevoUsuario, pinInicial });
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

async function registrarFraude({ usuarioId, tipoEvento, foto, similitud, notas }) {
  try {
    const p = await getPool();
    await p.request()
      .input('usuarioId', sql.Int, usuarioId)
      .input('tipo', sql.VarChar(50), tipoEvento)
      .input('foto', sql.NVarChar(sql.MAX), foto || null)
      .input('similitud', sql.Float, similitud || 0)
      .input('notas', sql.NVarChar(255), notas)
      .query(`
        INSERT INTO AuditoriaFraudeFacial (usuario_id, tipo_evento, foto_intento_url, similitud_obtenida, notas)
        VALUES (@usuarioId, @tipo, @foto, @similitud, @notas);
      `);
    console.warn(`🚨 [ALERTA DE FRAUDE] Usuario ${usuarioId}: ${tipoEvento} (${similitud}%).`);
    emitStaff('fraud_alert', { usuarioId, tipoEvento, similitudObtenida: similitud, fecha: new Date().toISOString() });
  } catch (err) {
    console.error('No se pudo registrar la auditoría de fraude:', err.message);
  }
}

// El cliente envía el descriptor de su rostro; el servidor lo compara con el enrolado.
// Si coincide, devuelve un ticket de un solo uso que exige check-in / check-out.
app.post('/api/biometric/verify', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { descriptor, foto, tipo } = req.body || {};
    const live = parseDescriptor(descriptor);
    if (!live || !validPhoto(foto) || !['entrada', 'salida'].includes(tipo)) {
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
    if (!live || !validPhoto(foto) || !['entrada', 'salida'].includes(tipo)) {
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
        e.id as estacion_id, e.nombre as estacion_nombre, e.codigo as estacion_codigo, e.color as estacion_color
      FROM Usuarios u
      LEFT JOIN RegistroAsistencia a ON u.id = a.usuario_id AND a.estado = 'activo'
      LEFT JOIN UbicacionesEnVivo uv ON u.id = uv.usuario_id AND uv.activo = 1
      LEFT JOIN EstacionesTrabajo e ON uv.estacion_actual_id = e.id
      WHERE u.rol = 'trabajador' AND u.activo = 1
      ORDER BY a.hora_ingreso DESC, u.nombre ASC;
    `);

    const trabajadores = result.recordset;
    const activos = trabajadores.filter((w) => w.estado_asistencia === 'activo');
    const dentro = activos.filter((w) => w.dentro_de_estacion).length;

    // Hora actual del servidor de base de datos: referencia para calcular el tiempo en turno
    const reloj = await p.request().query('SELECT GETDATE() AS ahora');

    res.json({
      ahora: reloj.recordset[0].ahora,
      resumen: {
        totalTrabajadores: trabajadores.length,
        activosConteo: activos.length,
        dentroEstacionConteo: dentro,
        fueraEstacionConteo: activos.length - dentro,
      },
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
             uv.latitud, uv.longitud, uv.precision, uv.dentro_de_estacion, uv.estacion_actual_id as estacion_id
      FROM RegistroAsistencia a
      LEFT JOIN UbicacionesEnVivo uv ON uv.usuario_id = a.usuario_id AND uv.activo = 1
      WHERE a.usuario_id = @id AND a.estado = 'activo'
    `);
    res.json(r.recordset[0] || null);
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/attendance/check-in', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { latitud, longitud, precision, fotoIngreso, ticket } = req.body || {};
    const usuarioId = req.user.id;

    if (!validCoords(latitud, longitud)) {
      return res.status(400).json({ error: 'latitud y longitud válidas son requeridas' });
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
          metodo_validacion, estado
        )
        OUTPUT INSERTED.id, INSERTED.usuario_id, INSERTED.hora_ingreso, INSERTED.latitud_ingreso,
               INSERTED.longitud_ingreso, INSERTED.precision_ingreso, INSERTED.estacion_ingreso_id,
               INSERTED.foto_ingreso_url, INSERTED.similitud_facial, INSERTED.verificacion_facial_exitosa,
               INSERTED.metodo_validacion, INSERTED.estado
        INTO @TempAsistencia
        VALUES (@usuarioId, GETDATE(), @lat, @lng, @acc, @estId, @foto, @similitud, 1, 'facial_biometrico', 'activo');

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

        COMMIT TRANSACTION;
      `);

    lastPings.delete(usuarioId);
    const registroCompletado = sinFotos(resActualizacion.recordset[0]);
    console.log(`🔔 [CHECK_OUT] Usuario ${usuarioId} registró SALIDA.`);
    emitStaff('attendance_event', { tipo: 'CHECK_OUT', usuarioId, asistencia: registroCompletado, fecha: new Date().toISOString() });

    res.json({ exito: true, mensaje: 'Salida registrada y rastreo GPS desactivado', asistencia: registroCompletado });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/location/ping', requireAuth(ROLES_WORKER), async (req, res) => {
  try {
    const { latitud, longitud, precision, velocidad, rumbo } = req.body || {};
    const usuarioId = req.user.id;
    if (!validCoords(latitud, longitud)) return res.status(400).json({ error: 'Parámetros incompletos' });

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

    const filtro = `
      WHERE (@desde IS NULL OR a.hora_ingreso >= @desde)
        AND (@hasta IS NULL OR a.hora_ingreso < @hasta)
        AND (@q IS NULL OR u.nombre LIKE @q OR u.codigo_empleado LIKE @q)`;
    const bind = (r) =>
      r.input('desde', sql.DateTime2, desde).input('hasta', sql.DateTime2, hasta).input('q', sql.NVarChar(120), qLike);

    const p = await getPool();
    const total = await bind(p.request()).query(
      `SELECT COUNT(*) AS total FROM RegistroAsistencia a JOIN Usuarios u ON a.usuario_id = u.id ${filtro}`
    );
    const result = await bind(p.request()).input('offset', sql.Int, offset).input('limit', sql.Int, limit).query(`
      SELECT
        a.id, a.usuario_id, u.nombre as nombre_usuario, u.codigo_empleado, u.cargo,
        ISNULL(DATALENGTH(u.foto_referencia_url), 0) AS foto_ref_bytes,
        a.hora_ingreso, a.hora_salida, a.latitud_ingreso, a.longitud_ingreso, a.latitud_salida, a.longitud_salida,
        CASE WHEN a.foto_ingreso_url IS NULL THEN 0 ELSE 1 END AS tiene_foto_ingreso,
        CASE WHEN a.foto_salida_url IS NULL THEN 0 ELSE 1 END AS tiene_foto_salida,
        a.similitud_facial, a.verificacion_facial_exitosa,
        a.metodo_validacion, a.estado, a.horas_totales,
        eIng.nombre as estacion_ingreso_nombre, eSal.nombre as estacion_salida_nombre
      FROM RegistroAsistencia a
      JOIN Usuarios u ON a.usuario_id = u.id
      LEFT JOIN EstacionesTrabajo eIng ON a.estacion_ingreso_id = eIng.id
      LEFT JOIN EstacionesTrabajo eSal ON a.estacion_salida_id = eSal.id
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
      title: 'Alerta de SMI',
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

    console.log(`🔔 [ALERTA ${alertaId}] ${req.user.id} -> usuario ${usuarioId}: ${exitosos}/${subs.length} dispositivos, app abierta: ${enApp}`);
    res.json({
      alertaId,
      trabajador: u.recordset[0].nombre,
      dispositivos: subs.length,
      entregadosAlServicioPush: exitosos,
      caducados: caducadas.length,
      appAbierta: enApp,
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

// ----------------- FOTOS BAJO DEMANDA (administración) -----------------
// Las listas ya no incluyen las fotos: el panel las pide una por una, solo cuando se ven.

const idParam = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

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

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🚀 Servidor SMI Asistencia & GPS corriendo en ${useTls ? 'https' : 'http'}://0.0.0.0:${config.port} (${isProduction ? 'producción' : 'desarrollo'})`);
  if (isProduction && !useTls && !config.trustProxy) {
    console.warn('⚠️ Producción sin HTTPS: la cámara y el GPS del celular exigen HTTPS (usa SSL_KEY_PATH/SSL_CERT_PATH o un proxy inverso con TRUST_PROXY=1).');
  }
  checkPinColumn();
  checkPushTables();
});
