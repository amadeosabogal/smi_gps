// Genera un par de claves VAPID para las notificaciones push.
//
// Uso:   node service/generate-vapid.mjs            -> imprime las 3 líneas para pegar en service/.env
//        node service/generate-vapid.mjs --write    -> las agrega a service/.env si todavía no existen
//
// La clave PRIVADA es un secreto: no la subas a git ni la compartas. Usa una pareja distinta en
// desarrollo y en producción (cada suscripción de celular queda atada a la clave pública con la que se creó).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as webpush from 'web-push';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const lineas = `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:soporte@smi-peru.com\n`;

if (process.argv.includes('--write')) {
  const actual = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (/^VAPID_PRIVATE_KEY=.+/m.test(actual)) {
    console.log('service/.env ya tiene claves VAPID: no se cambia nada (cambiarlas invalida las suscripciones existentes).');
  } else {
    fs.appendFileSync(envPath, `${actual.endsWith('\n') || !actual ? '' : '\n'}\n# --- Notificaciones push (VAPID) ---\n${lineas}`);
    console.log('✅ Claves VAPID agregadas a service/.env (la clave privada no se muestra).');
    console.log('   Cambia VAPID_SUBJECT por un correo real de contacto.');
  }
} else {
  console.log('Pega estas líneas en service/.env (y cambia el correo de VAPID_SUBJECT):\n');
  console.log(lineas);
}
