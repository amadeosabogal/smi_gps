// Índices para que el historial y la retención sigan siendo rápidos con muchos registros:
//   - HistorialUbicaciones(fecha_registro): borrar/consultar puntos GPS por fecha
//   - RegistroAsistencia(hora_ingreso):     filtrar y paginar el historial por fecha
//
// Uso:   node service/migrate-historial.mjs            (aplica los cambios)
//        node service/migrate-historial.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');
const indices = [
  { nombre: 'IX_HistorialUbicaciones_fecha', tabla: 'HistorialUbicaciones', columnas: 'fecha_registro' },
  { nombre: 'IX_RegistroAsistencia_hora_ingreso', tabla: 'RegistroAsistencia', columnas: 'hora_ingreso DESC' },
];

const pool = await sql.connect({ ...dbConfig, requestTimeout: 300000 });
try {
  console.log(`📈 Índices de rendimiento en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  for (const ix of indices) {
    const r = await pool.request().query(
      `SELECT COUNT(*) n FROM sys.indexes WHERE name = '${ix.nombre}' AND object_id = OBJECT_ID('${ix.tabla}')`
    );
    if (r.recordset[0].n) {
      console.log(`• ${ix.nombre}: ya existe.`);
    } else if (dryRun) {
      console.log(`• ${ix.nombre}: se crearía sobre ${ix.tabla}(${ix.columnas}).`);
    } else {
      await pool.request().query(`CREATE INDEX ${ix.nombre} ON ${ix.tabla} (${ix.columnas})`);
      console.log(`✅ ${ix.nombre}: creado.`);
    }
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
