// Almuerzo dentro del turno: crea la tabla AlmuerzosTurno.
//   - Cada almuerzo guarda inicio y fin, las fotos y la similitud facial de ambos momentos y quién lo cerró.
//   - Un índice único impide tener dos almuerzos abiertos a la vez en el mismo turno.
// El GPS NO se detiene durante el almuerzo: esta tabla solo marca el período dentro del turno.
//
// Uso:   node service/migrate-almuerzo.mjs            (crea lo que falte)
//        node service/migrate-almuerzo.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🍽️ Tabla AlmuerzosTurno en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const r = await pool.request().query("SELECT OBJECT_ID('AlmuerzosTurno', 'U') AS id");
  if (r.recordset[0].id) {
    console.log('• AlmuerzosTurno: ya existe.');
  } else if (dryRun) {
    console.log('• Se crearía la tabla AlmuerzosTurno y sus 2 índices.');
  } else {
    await pool.request().query(`
      CREATE TABLE AlmuerzosTurno (
        id INT IDENTITY(1,1) PRIMARY KEY,
        asistencia_id INT NOT NULL FOREIGN KEY REFERENCES RegistroAsistencia(id),
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        inicio_en DATETIME2 NOT NULL DEFAULT GETDATE(),
        fin_en DATETIME2 NULL,
        similitud_inicio FLOAT NULL,
        similitud_fin FLOAT NULL,
        foto_inicio_url NVARCHAR(MAX) NULL,
        foto_fin_url NVARCHAR(MAX) NULL,
        latitud_inicio FLOAT NULL,
        longitud_inicio FLOAT NULL,
        latitud_fin FLOAT NULL,
        longitud_fin FLOAT NULL,
        cierre VARCHAR(20) NULL -- 'trabajador' | 'salida' | 'administrador'
      );
      CREATE INDEX IX_AlmuerzosTurno_asistencia ON AlmuerzosTurno (asistencia_id);
      CREATE UNIQUE INDEX UX_AlmuerzosTurno_abierto ON AlmuerzosTurno (asistencia_id) WHERE fin_en IS NULL;
    `);
    console.log('✅ Tabla AlmuerzosTurno creada. Reinicia el servidor (pm2 restart smi-gps) para habilitar el almuerzo.');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
