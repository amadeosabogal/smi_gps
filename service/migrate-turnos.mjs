// Impide que un trabajador tenga dos turnos activos a la vez (por doble toque o dos dispositivos).
// Crea un índice único filtrado: solo una fila con estado = 'activo' por usuario.
//
// Uso:   node service/migrate-turnos.mjs            (aplica el cambio)
//        node service/migrate-turnos.mjs --dry-run   (solo revisa; no cambia nada)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');
const INDEX = 'UX_RegistroAsistencia_turno_activo';

const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });
try {
  console.log(`🔐 Índice de turno activo único en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);

  const existe = await pool.request().query(`SELECT COUNT(*) n FROM sys.indexes WHERE name = '${INDEX}' AND object_id = OBJECT_ID('RegistroAsistencia')`);
  if (existe.recordset[0].n) {
    console.log('• El índice ya existe. No hay nada que hacer.');
  } else {
    const dup = await pool.request().query(`
      SELECT a.usuario_id, u.codigo_empleado, COUNT(*) AS turnos_activos
        FROM RegistroAsistencia a JOIN Usuarios u ON u.id = a.usuario_id
       WHERE a.estado = 'activo'
       GROUP BY a.usuario_id, u.codigo_empleado
      HAVING COUNT(*) > 1`);

    if (dup.recordset.length) {
      console.log('⚠️  No se puede crear el índice: hay trabajadores con MÁS DE UN turno activo:');
      console.table(dup.recordset);
      console.log('   Ciérralos o corrígelos (deja un solo turno activo por trabajador) y vuelve a ejecutar.');
      process.exitCode = 1;
    } else {
      console.log('• No hay turnos activos duplicados: se puede crear el índice.');
      if (!dryRun) {
        await pool.request().query(`CREATE UNIQUE INDEX ${INDEX} ON RegistroAsistencia (usuario_id) WHERE estado = 'activo'`);
        console.log('✅ Índice creado.');
      }
    }
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
