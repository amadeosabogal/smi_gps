// Autorización de la oficina: crea la tabla SolicitudesMarcacion.
//   - Cada solicitud guarda el tipo (entrada, salida o almuerzo), la foto, la similitud del rostro, la ubicación y
//     quién la resolvió y cuándo.
//   - Un índice único impide que un trabajador tenga dos solicitudes pendientes a la vez.
// No modifica ninguna tabla existente. Sin ella el servidor funciona como antes (la app no ofrece pedir autorización).
//
// Uso:   node service/migrate-autorizaciones.mjs             (crea lo que falte)
//        node service/migrate-autorizaciones.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🙋 Tabla SolicitudesMarcacion en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const r = await pool.request().query("SELECT OBJECT_ID('SolicitudesMarcacion', 'U') AS id");
  if (r.recordset[0].id) {
    console.log('• SolicitudesMarcacion: ya existe.');
  } else if (dryRun) {
    console.log('• Se crearía la tabla SolicitudesMarcacion y sus 2 índices.');
  } else {
    await pool.request().query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      CREATE TABLE SolicitudesMarcacion (
        id INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        tipo VARCHAR(20) NOT NULL,                      -- entrada | salida | almuerzo_inicio | almuerzo_fin
        estado VARCHAR(12) NOT NULL DEFAULT 'pendiente', -- pendiente | aprobada | rechazada | vencida | anulada
        creada_en DATETIME2 NOT NULL DEFAULT GETDATE(),  -- es la hora que se registra si se aprueba
        foto_solicitud_url NVARCHAR(MAX) NULL,
        similitud FLOAT NOT NULL,
        sin_verificacion BIT NOT NULL DEFAULT 0,         -- la prueba de vida no cargó en el celular
        fallos INT NOT NULL DEFAULT 0,
        latitud FLOAT NULL,
        longitud FLOAT NULL,
        precision_m FLOAT NULL,
        estacion_id INT NULL,
        dispositivo_id VARCHAR(64) NULL,
        resuelta_en DATETIME2 NULL,
        resuelta_por INT NULL,
        motivo_rechazo NVARCHAR(200) NULL,
        asistencia_id INT NULL
      );
      CREATE INDEX IX_SolicitudesMarcacion_usuario ON SolicitudesMarcacion (usuario_id, creada_en);
      CREATE UNIQUE INDEX UX_SolicitudesMarcacion_pendiente ON SolicitudesMarcacion (usuario_id) WHERE estado = 'pendiente';
      COMMIT TRANSACTION;
    `);
    console.log('✅ Tabla SolicitudesMarcacion creada. Reinicia el servidor (pm2 restart smi-gps) para habilitar las autorizaciones.');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
