// Utilidades de autenticación: hash de PIN, tokens firmados y limitador de intentos.
// Solo usa el módulo crypto de Node (sin dependencias nuevas).
import crypto from 'crypto';

// ---------- PIN ----------
const SCRYPT_PREFIX = 'scrypt$';

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function isHashedPin(stored) {
  return typeof stored === 'string' && stored.startsWith(SCRYPT_PREFIX);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Verifica un PIN contra el valor guardado (hash scrypt, o texto plano heredado antes de migrar). */
export function verifyPin(pin, stored) {
  if (pin === undefined || pin === null || !stored) return false;
  if (isHashedPin(stored)) {
    const [, saltHex, hashHex] = stored.split('$');
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }
  return safeEqual(pin, stored);
}

// ---------- Tokens firmados (HMAC-SHA256, formato compacto tipo JWT) ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload, ttlSeconds, secret) {
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Devuelve el payload si el token es válido y no expiró; si no, null. */
export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  let given;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- Limitador de intentos en memoria ----------
export function createLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }

  const current = (key) => {
    const entry = hits.get(key);
    if (!entry) return null;
    if (entry.resetAt <= Date.now()) {
      hits.delete(key);
      return null;
    }
    return entry;
  };

  return {
    /** ¿Está bloqueada la clave? Devuelve segundos restantes o 0. */
    blockedFor(key) {
      const entry = current(key);
      if (entry && entry.count >= max) return Math.ceil((entry.resetAt - Date.now()) / 1000);
      return 0;
    },
    /** Registra un intento fallido. */
    fail(key) {
      const entry = current(key);
      if (entry) entry.count += 1;
      else hits.set(key, { count: 1, resetAt: Date.now() + windowMs });
    },
    /** Limpia la clave tras un éxito. */
    reset(key) {
      hits.delete(key);
    },
  };
}

/** Distancia euclidiana entre dos descriptores faciales de 128 valores. */
export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Mismo mapeo de similitud (%) que usaba el cliente. */
export function similarityFromDistance(distance) {
  return Math.max(0, Math.min(100, Math.round((1 - Math.pow(distance / 1.15, 1.5)) * 100)));
}

/** Valida y normaliza un descriptor facial recibido del cliente. */
export function parseDescriptor(value) {
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length !== 128) return null;
  const out = arr.map(Number);
  return out.every((n) => Number.isFinite(n) && Math.abs(n) < 10) ? out : null;
}
