// Ingreso del trabajador con DNI y contraseña: añade Usuarios.dni (único cuando está informado).
// Después de migrar hay que cargar el DNI de cada trabajador desde el panel (Personal y biometría → Datos).
//
// Uso:   node service/migrate-dni.mjs            (aplica el cambio)
//        node service/migrate-dni.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🪪 Columna dni en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  const col = (await pool.request().query("SELECT COL_LENGTH('Usuarios', 'dni') AS n")).recordset[0].n;
  if (col) {
    console.log('• Usuarios.dni: ya existe.');
  } else if (dryRun) {
    console.log('• Se añadiría Usuarios.dni VARCHAR(12) NULL.');
  } else {
    await pool.request().query('ALTER TABLE Usuarios ADD dni VARCHAR(12) NULL');
    console.log('• Usuarios.dni creada.');
  }

  const idx = (await pool.request().query("SELECT 1 AS ok FROM sys.indexes WHERE name = 'UX_Usuarios_dni' AND object_id = OBJECT_ID('Usuarios')")).recordset.length;
  if (idx) {
    console.log('• Índice único UX_Usuarios_dni: ya existe.');
  } else if (dryRun) {
    console.log('• Se crearía el índice único UX_Usuarios_dni (no permite dos usuarios con el mismo DNI).');
  } else {
    await pool.request().query('CREATE UNIQUE INDEX UX_Usuarios_dni ON Usuarios (dni) WHERE dni IS NOT NULL');
    console.log('• Índice único UX_Usuarios_dni creado.');
  }

  if (!dryRun) {
    const sin = (await pool.request().query("SELECT COUNT(*) AS n FROM Usuarios WHERE rol = 'trabajador' AND activo = 1 AND dni IS NULL")).recordset[0].n;
    console.log(`✅ Listo. Trabajadores activos SIN DNI: ${sin}. Cárgalos desde el panel (Personal y biometría → Datos) y reinicia el servidor (pm2 restart smi-gps).`);
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
