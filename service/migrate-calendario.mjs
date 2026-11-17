// Calendario de días no laborables: crea las tablas necesarias.
//   - CalendarioDias:        decisión del administrador para una fecha concreta (habilitar o bloquear la app, con motivo).
//   - CalendarioExcepciones: trabajadores autorizados a usar la app en una fecha no laborable.
//   - CalendarioConfig:      días libres fijos de la semana (por ejemplo, domingos). Por defecto: ninguno.
// Los feriados de Perú NO se guardan aquí: el servidor los calcula (service/feriados-peru.mjs).
//
// Uso:   node service/migrate-calendario.mjs            (crea lo que falte)
//        node service/migrate-calendario.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`📅 Calendario laboral en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const existe = async (t) => Boolean((await pool.request().query(`SELECT OBJECT_ID('${t}', 'U') AS id`)).recordset[0].id);

  if (await existe('CalendarioDias')) console.log('• CalendarioDias: ya existe.');
  else if (dryRun) console.log('• Se crearía CalendarioDias.');
  else {
    await pool.request().query(`
      CREATE TABLE CalendarioDias (
        fecha DATE NOT NULL PRIMARY KEY,
        laborable BIT NOT NULL,             -- 1 = la app queda habilitada ese día · 0 = bloqueada
        motivo NVARCHAR(120) NULL,
        creado_por INT NULL,
        creado_en DATETIME2 NOT NULL DEFAULT GETDATE()
      );
    `);
    console.log('• CalendarioDias creada.');
  }

  if (await existe('CalendarioExcepciones')) console.log('• CalendarioExcepciones: ya existe.');
  else if (dryRun) console.log('• Se crearía CalendarioExcepciones.');
  else {
    await pool.request().query(`
      CREATE TABLE CalendarioExcepciones (
        id INT IDENTITY(1,1) PRIMARY KEY,
        fecha DATE NOT NULL,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        motivo NVARCHAR(120) NULL,
        creado_por INT NULL,
        creado_en DATETIME2 NOT NULL DEFAULT GETDATE(),
        CONSTRAINT UX_CalendarioExcepciones UNIQUE (fecha, usuario_id)
      );
    `);
    console.log('• CalendarioExcepciones creada.');
  }

  if (await existe('CalendarioConfig')) console.log('• CalendarioConfig: ya existe.');
  else if (dryRun) console.log('• Se crearía CalendarioConfig (sin días libres fijos).');
  else {
    await pool.request().query(`
      CREATE TABLE CalendarioConfig (
        clave VARCHAR(40) NOT NULL PRIMARY KEY,
        valor NVARCHAR(200) NOT NULL
      );
      INSERT INTO CalendarioConfig (clave, valor) VALUES ('dias_libres', '');
    `);
    console.log('• CalendarioConfig creada (sin días libres fijos: configúralos desde el panel).');
  }

  if (!dryRun) console.log('✅ Listo. Reinicia el servidor (pm2 restart smi-gps) para activar el bloqueo en días no laborables.');
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
