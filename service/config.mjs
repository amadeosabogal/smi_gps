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
  // Notificaciones push (se generan con: npm run vapid). Sin ellas, las alertas quedan desactivadas.
  vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
  vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  // Precisión GPS exigida (metros). Una ubicación aproximada (p. ej. ±2000 m) no sirve para saber en qué estación está alguien.
  gpsMaxPrecisionCheckin: Number(env.GPS_MAX_ACCURACY_CHECKIN_M || 50),
  gpsMaxPrecisionPing: Number(env.GPS_MAX_ACCURACY_PING_M || 100),
  // Antigüedad máxima (ms) de la lectura GPS que el celular declara al marcar (evita usar posiciones viejas)
  gpsMaxAgeMs: Number(env.GPS_MAX_AGE_MS || 30000),
  // Vigencia (horas) del token que usa el servicio nativo de Android para enviar ubicaciones con la app cerrada
  trackTokenHours: Number(env.TRACK_TOKEN_HOURS || 18),
  // Archivo version.json que se publica junto al APK; la app Android lo consulta para avisar de versiones nuevas
  androidVersionFile: env.ANDROID_VERSION_FILE || '/var/www/smi_descargas/version.json',
  // Almuerzo dentro del turno: minutos permitidos (el panel marca en rojo al que se pasa) y cuántos por turno
  almuerzoMinutos: Number(env.ALMUERZO_MINUTOS || 60),
  almuerzosPorTurno: Number(env.ALMUERZOS_POR_TURNO || 1),
  // Zona horaria con la que se decide qué día es "hoy" para el calendario de días no laborables
  zonaHoraria: env.BUSINESS_TZ || 'America/Lima',
  // Nombre de la marca de esta instalación (alertas al celular, mensajes). Vacío = SMI. La web usa VITE_BRAND_NAME (client/.env).
  marcaNombre: (env.BRAND_NAME || '').trim() || 'SMI',
  // true = el trabajador SOLO ingresa con DNI y contraseña: se apaga el ingreso antiguo por nombre y la lista pública de nombres.
  // Dejar en false mientras haya celulares con la app antigua o trabajadores sin DNI cargado.
  loginSoloDni: env.LOGIN_SOLO_DNI === 'true',
  // Plazos de conservación de datos personales (días; vacío = no borrar nunca; mínimo 30). Ver service/retencion.mjs
  retencionFotosDias: Number(env.RETENCION_FOTOS_DIAS || 0),
  retencionRegistrosDias: Number(env.RETENCION_REGISTROS_DIAS || 0),
  // Aviso de privacidad dentro de la app: datos de la empresa que se muestran al trabajador y si la aceptación es obligatoria.
  // Si se sube PRIVACIDAD_VERSION, todos deben volver a aceptar.
  exigirAceptacionPrivacidad: env.EXIGIR_ACEPTACION_PRIVACIDAD === 'true',
  privacidadVersion: Number(env.PRIVACIDAD_VERSION || 1),
  empresa: {
    nombre: env.EMPRESA_NOMBRE || '',
    ruc: env.EMPRESA_RUC || '',
    domicilio: env.EMPRESA_DOMICILIO || '',
    correoDatos: env.EMPRESA_CORREO_DATOS || '',
    proveedor: env.EMPRESA_PROVEEDOR || '',
    paisServidor: env.EMPRESA_PAIS_SERVIDOR || '',
    alternativa: env.EMPRESA_ALTERNATIVA_SIN_AUTORIZACION || '',
    diasRostroTrasCese: Number(env.EMPRESA_DIAS_ROSTRO_TRAS_CESE || 30),
  },
  sessionHours: Number(env.SESSION_HOURS || 12),
  adminSessionHours: Number(env.ADMIN_SESSION_HOURS || 8),
  // TLS opcional directo en Node (si no se usa un proxy inverso como nginx/Caddy)
  sslKeyPath: env.SSL_KEY_PATH || '',
  sslCertPath: env.SSL_CERT_PATH || '',
  // Poner en "1" si hay un proxy inverso delante (para leer bien la IP real y el protocolo)
  trustProxy: env.TRUST_PROXY || '',
};
