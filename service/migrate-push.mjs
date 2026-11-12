// Crea las tablas de las notificaciones push (idempotente):
//   SuscripcionesPush : los celulares que aceptaron recibir alertas (un registro por navegador/dispositivo)
//   AlertasEnviadas   : auditoría de cada alerta (quién la envió, a quién, qué mensaje, si fue leída)
//
// Uso:   node service/migrate-push.mjs            (crea lo que falte)
//        node service/migrate-push.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pasos = [
  {
    nombre: 'tabla SuscripcionesPush',
    existe: "SELECT OBJECT_ID('SuscripcionesPush', 'U') AS id",
    crear: `
      CREATE TABLE SuscripcionesPush (
        id INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        endpoint NVARCHAR(450) NOT NULL,
        p256dh NVARCHAR(200) NOT NULL,
        auth NVARCHAR(100) NOT NULL,
        user_agent NVARCHAR(300) NULL,
        creado_en DATETIME2 NOT NULL DEFAULT GETDATE()
      );
      CREATE UNIQUE INDEX UX_SuscripcionesPush_endpoint ON SuscripcionesPush (endpoint);
      CREATE INDEX IX_SuscripcionesPush_usuario ON SuscripcionesPush (usuario_id);`,
  },
  {
    nombre: 'tabla AlertasEnviadas',
    existe: "SELECT OBJECT_ID('AlertasEnviadas', 'U') AS id",
    crear: `
      CREATE TABLE AlertasEnviadas (
        id INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        enviado_por INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        mensaje NVARCHAR(300) NOT NULL,
        dispositivos INT NOT NULL DEFAULT 0,
        exitosos INT NOT NULL DEFAULT 0,
        enviada_en DATETIME2 NOT NULL DEFAULT GETDATE(),
        leida_en DATETIME2 NULL
      );
      CREATE INDEX IX_AlertasEnviadas_usuario ON AlertasEnviadas (usuario_id, enviada_en DESC);`,
  },
];

const pool = await sql.connect({ ...dbConfig, requestTimeout: 120000 });
try {
  console.log(`🔔 Tablas de notificaciones push en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  for (const paso of pasos) {
    const r = await pool.request().query(paso.existe);
    if (r.recordset[0].id) {
      console.log(`• ${paso.nombre}: ya existe.`);
    } else if (dryRun) {
      console.log(`• ${paso.nombre}: se crearía.`);
    } else {
      await pool.request().query(paso.crear);
      console.log(`✅ ${paso.nombre}: creada.`);
    }
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
