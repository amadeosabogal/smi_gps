// Prepara la base para los recordatorios automáticos de marcación (idempotente):
//   RecordatoriosConfig                : las horas que fija la oficina desde el panel
//   AlertasEnviadas.asistencia_id      : turno al que corresponde un recordatorio
//   AlertasEnviadas.recordatorio       : qué recordatorio es (evita enviarlo dos veces)
// Requiere las tablas de notificaciones (npm run migrate-push). No envía nada hasta que la oficina guarde las horas.
//
// Uso:   node service/migrate-recordatorios.mjs            (crea lo que falte)
//        node service/migrate-recordatorios.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pasos = [
  {
    nombre: 'tabla RecordatoriosConfig',
    existe: "SELECT OBJECT_ID('RecordatoriosConfig', 'U') AS id",
    crear: `
      CREATE TABLE RecordatoriosConfig (
        clave VARCHAR(40) NOT NULL PRIMARY KEY,
        valor NVARCHAR(2000) NOT NULL,
        actualizado_por INT NULL,
        actualizado_en DATETIME2 NOT NULL DEFAULT GETDATE()
      );`,
  },
  {
    nombre: 'columna AlertasEnviadas.asistencia_id',
    existe: "SELECT COL_LENGTH('AlertasEnviadas', 'asistencia_id') AS id",
    crear: 'ALTER TABLE AlertasEnviadas ADD asistencia_id INT NULL;',
  },
  {
    nombre: 'columna AlertasEnviadas.recordatorio',
    existe: "SELECT COL_LENGTH('AlertasEnviadas', 'recordatorio') AS id",
    crear: 'ALTER TABLE AlertasEnviadas ADD recordatorio VARCHAR(40) NULL;',
  },
  {
    nombre: 'índice que evita recordatorios repetidos',
    existe: "SELECT INDEXPROPERTY(OBJECT_ID('AlertasEnviadas'), 'UX_AlertasEnviadas_recordatorio', 'IndexID') AS id",
    crear: `
      CREATE UNIQUE INDEX UX_AlertasEnviadas_recordatorio ON AlertasEnviadas (asistencia_id, recordatorio)
       WHERE recordatorio IS NOT NULL;`,
  },
];

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`⏰ Recordatorios de marcación en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const base = await pool.request().query("SELECT OBJECT_ID('AlertasEnviadas', 'U') AS id");
  if (!base.recordset[0].id) {
    console.error('❌ Falta la tabla AlertasEnviadas: ejecuta primero  npm run migrate-push');
    process.exitCode = 1;
  } else {
    for (const paso of pasos) {
      const r = await pool.request().query(paso.existe);
      if (r.recordset[0].id) {
        console.log(`• ${paso.nombre}: ya existe.`);
      } else if (dryRun) {
        console.log(`• ${paso.nombre}: se crearía.`);
      } else {
        await pool.request().query(paso.crear);
        console.log(`✅ ${paso.nombre}: creado.`);
      }
    }
    if (!dryRun) console.log('Reinicia el servidor (pm2 restart smi-gps) y fija las horas en el panel (Calendario y avisos).');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
