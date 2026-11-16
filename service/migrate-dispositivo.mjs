// Ata cada turno al dispositivo (celular) que marcó la entrada: añade RegistroAsistencia.dispositivo_id.
// Solo ese dispositivo puede enviar la ubicación del turno; así dos celulares con el mismo usuario no mezclan sus puntos.
//
// Uso:   node service/migrate-dispositivo.mjs            (aplica el cambio)
//        node service/migrate-dispositivo.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`📱 Columna dispositivo_id en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const r = await pool.request().query("SELECT COL_LENGTH('RegistroAsistencia', 'dispositivo_id') AS n");
  if (r.recordset[0].n) {
    console.log('• La columna ya existe. No hay nada que hacer.');
  } else if (dryRun) {
    console.log('• Se añadiría RegistroAsistencia.dispositivo_id VARCHAR(64) NULL.');
  } else {
    await pool.request().query('ALTER TABLE RegistroAsistencia ADD dispositivo_id VARCHAR(64) NULL');
    console.log('✅ Columna creada. Reinicia el servidor (pm2 restart smi-gps) para que la use.');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
