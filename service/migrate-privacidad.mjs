// Aceptación del aviso de privacidad dentro de la aplicación: crea la tabla AceptacionesPrivacidad.
// Guarda quién aceptó, qué versión del aviso, cuándo, desde qué dispositivo y qué autorizaciones otorgó.
//
// Uso:   node service/migrate-privacidad.mjs            (crea lo que falte)
//        node service/migrate-privacidad.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🔏 Aceptación del aviso de privacidad en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const r = await pool.request().query("SELECT OBJECT_ID('AceptacionesPrivacidad', 'U') AS id");
  if (r.recordset[0].id) {
    console.log('• AceptacionesPrivacidad: ya existe.');
  } else if (dryRun) {
    console.log('• Se crearía la tabla AceptacionesPrivacidad.');
  } else {
    await pool.request().query(`
      CREATE TABLE AceptacionesPrivacidad (
        id INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        version INT NOT NULL,
        aceptado_en DATETIME2 NOT NULL DEFAULT GETDATE(),
        autoriza_rostro BIT NOT NULL,
        autoriza_ubicacion BIT NOT NULL,
        autoriza_datos BIT NOT NULL,
        dispositivo_id VARCHAR(80) NULL,
        CONSTRAINT UX_AceptacionesPrivacidad UNIQUE (usuario_id, version)
      );
    `);
    console.log('✅ Tabla AceptacionesPrivacidad creada. Reinicia el servidor (pm2 restart smi-gps).');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
