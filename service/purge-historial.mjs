// Elimina puntos GPS antiguos del recorrido (HistorialUbicaciones). NO toca la asistencia ni las fotos.
//
// Uso:   node service/purge-historial.mjs --days=90             (SOLO cuenta; no borra nada)
//        node service/purge-historial.mjs --days=90 --apply     (borra en lotes)
//
// Mínimo 7 días. Esta acción NO se puede deshacer: haz un respaldo de la base antes si lo necesitas.
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const arg = process.argv.find((a) => a.startsWith('--days='));
const dias = arg ? Number(arg.split('=')[1]) : NaN;
const aplicar = process.argv.includes('--apply');

if (!Number.isInteger(dias) || dias < 7) {
  console.error('Indica los días a conservar (mínimo 7). Ejemplo: node service/purge-historial.mjs --days=90');
  process.exit(1);
}

const pool = await sql.connect({ ...dbConfig, requestTimeout: 300000 });
try {
  const cuenta = await pool.request().input('dias', sql.Int, dias).query(`
    SELECT COUNT(*) AS antiguos, (SELECT COUNT(*) FROM HistorialUbicaciones) AS total
      FROM HistorialUbicaciones WHERE fecha_registro < DATEADD(DAY, -@dias, GETDATE())`);
  const { antiguos, total } = cuenta.recordset[0];
  console.log(`Puntos GPS en total: ${total}. Con más de ${dias} días: ${antiguos}.`);

  if (!aplicar) {
    console.log('(Simulación: no se borró nada. Agrega --apply para borrar.)');
  } else {
    let borrados = 0;
    for (;;) {
      const r = await pool.request().input('dias', sql.Int, dias).query(
        'DELETE TOP (5000) FROM HistorialUbicaciones WHERE fecha_registro < DATEADD(DAY, -@dias, GETDATE())'
      );
      const n = r.rowsAffected[0] || 0;
      borrados += n;
      process.stdout.write(`\rBorrados: ${borrados}`);
      if (n < 5000) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    console.log(`\n✅ Listo: ${borrados} puntos GPS eliminados.`);
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
