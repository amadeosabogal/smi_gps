// Configuración centralizada del backend. Todo secreto sale de service/.env (nunca del código).
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const env = process.env;
export const isProduction = env.NODE_ENV === 'production';

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`❌ Falta la variable de entorno ${name}. Revisa service/.env (ver service/.env.example).`);
    process.exit(1);
  }
  return value;
}

export const dbConfig = {
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  server: required('DB_HOST'),
  port: Number(env.DB_PORT || 1433),
  database: env.DB_NAME || 'GPS_SMI',
  options: {
    encrypt: env.DB_ENCRYPT === 'true',
    trustServerCertificate: env.DB_TRUST_CERT !== 'false',
    connectTimeout: 20000,
  },
};

export const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) {
  console.error('❌ JWT_SECRET debe tener al menos 32 caracteres.');
  process.exit(1);
}

export const config = {
  port: Number(env.PORT || 3001),
  // Lista separada por comas de orígenes permitidos (CORS y WebSocket). Vacío = solo mismo origen.
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Umbral de distancia euclidiana para considerar que dos rostros son la misma persona
  faceMatchThreshold: Number(env.FACE_MATCH_THRESHOLD || 0.58),
  // Intentos de login FALLIDOS por IP en 10 min. Alto a propósito: toda una planta suele salir por la misma IP.
  loginIpMax: Number(env.LOGIN_IP_MAX || 60),
  sessionHours: Number(env.SESSION_HOURS || 12),
  adminSessionHours: Number(env.ADMIN_SESSION_HOURS || 8),
  // TLS opcional directo en Node (si no se usa un proxy inverso como nginx/Caddy)
  sslKeyPath: env.SSL_KEY_PATH || '',
  sslCertPath: env.SSL_CERT_PATH || '',
  // Poner en "1" si hay un proxy inverso delante (para leer bien la IP real y el protocolo)
  trustProxy: env.TRUST_PROXY || '',
};
