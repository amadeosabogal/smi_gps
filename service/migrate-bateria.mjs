// Guarda el porcentaje de batería y si el teléfono estaba cargando junto a cada punto GPS (app Android):
//   HistorialUbicaciones(bateria, cargando)  -> curva de batería del turno en el visor de recorrido
//   UbicacionesEnVivo(bateria, cargando)     -> estado actual en la tarjeta de cada trabajador
// Son columnas que admiten NULL: SQL Server las añade al instante, sin reescribir la tabla.
//
// Uso:   node service/migrate-bateria.mjs            (aplica el cambio)
//        node service/migrate-bateria.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');
const tablas = ['HistorialUbicaciones', 'UbicacionesEnVivo'];

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🔋 Columnas de batería en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  for (const t of tablas) {
    const r = await pool.request().query(`SELECT COL_LENGTH('${t}', 'bateria') AS b, COL_LENGTH('${t}', 'cargando') AS c`);
    const { b, c } = r.recordset[0];
    const faltan = [!b && 'bateria TINYINT NULL', !c && 'cargando BIT NULL'].filter(Boolean);
    if (!faltan.length) {
      console.log(`• ${t}: ya tiene las columnas.`);
    } else if (dryRun) {
      console.log(`• ${t}: se añadiría ${faltan.join(', ')}.`);
    } else {
      for (const col of faltan) await pool.request().query(`ALTER TABLE ${t} ADD ${col}`);
      console.log(`✅ ${t}: columnas creadas.`);
    }
  }
  if (!dryRun) console.log('Reinicia el servidor (pm2 restart smi-gps) para que las use.');
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
