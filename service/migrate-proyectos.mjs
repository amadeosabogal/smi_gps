// Proyectos: agrupan las estaciones (por ejemplo "Metro de Lima"). Crea la tabla Proyectos y añade
// EstacionesTrabajo.proyecto_id (opcional). Las estaciones que ya existen quedan "Sin proyecto".
//
// Uso:   node service/migrate-proyectos.mjs            (aplica el cambio)
//        node service/migrate-proyectos.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🗂️ Proyectos en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);

  const tabla = (await pool.request().query("SELECT OBJECT_ID('Proyectos', 'U') AS id")).recordset[0].id;
  if (tabla) {
    console.log('• Tabla Proyectos: ya existe.');
  } else if (dryRun) {
    console.log('• Se crearía la tabla Proyectos (id, codigo único, nombre, color, activo, creado_en).');
  } else {
    await pool.request().query(`
      CREATE TABLE Proyectos (
        id INT IDENTITY(1,1) PRIMARY KEY,
        codigo VARCHAR(50) NOT NULL,
        nombre NVARCHAR(150) NOT NULL,
        color VARCHAR(20) NOT NULL DEFAULT '#3B82F6',
        activo BIT NOT NULL DEFAULT 1,
        creado_en DATETIME2 NOT NULL DEFAULT GETDATE()
      );
    `);
    console.log('• Tabla Proyectos creada.');
  }

  const col = (await pool.request().query("SELECT COL_LENGTH('EstacionesTrabajo', 'proyecto_id') AS n")).recordset[0].n;
  if (col) {
    console.log('• EstacionesTrabajo.proyecto_id: ya existe.');
  } else if (dryRun) {
    console.log('• Se añadiría EstacionesTrabajo.proyecto_id INT NULL.');
  } else {
    await pool.request().query('ALTER TABLE EstacionesTrabajo ADD proyecto_id INT NULL');
    console.log('• EstacionesTrabajo.proyecto_id creada (todas las estaciones quedan "Sin proyecto").');
  }

  if (!dryRun) console.log('✅ Listo. Reinicia el servidor (pm2 restart <nombre>) para habilitar los proyectos.');
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
