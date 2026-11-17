// Limpieza de datos de prueba antes de pasar a producción.
//
// BORRA (todo el historial):  asistencias (entradas/salidas y sus fotos), recorridos GPS, ubicaciones en vivo,
//                             almuerzos, alertas enviadas por supervisores y alertas de fraude.
// CONSERVA:                   usuarios (con su rostro enrolado y PIN), estaciones, calendario, suscripciones push
//                             y la configuración. Los contadores de id vuelven a empezar en 1.
//
// Uso:   node service/limpiar-pruebas.mjs                          (solo MUESTRA qué se borraría; no cambia nada)
//        node service/limpiar-pruebas.mjs --confirmar              (borra de verdad)
//        node service/limpiar-pruebas.mjs --confirmar --respaldo "C:\\Respaldos\\GPS_SMI.bak"
//             (antes de borrar hace un BACKUP de la base; la ruta es del equipo donde corre SQL Server)
//
// Si hay turnos ACTIVOS se niega a borrar: pide a esos trabajadores que marquen salida (o fuerza la salida desde el panel).
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const confirmar = process.argv.includes('--confirmar');
const iRespaldo = process.argv.indexOf('--respaldo');
const rutaRespaldo = iRespaldo >= 0 ? process.argv[iRespaldo + 1] : null;
if (iRespaldo >= 0 && (!rutaRespaldo || rutaRespaldo.startsWith('--'))) {
  console.error('❌ Falta la ruta después de --respaldo.');
  process.exit(1);
}

// Orden de borrado: primero lo que depende de otras tablas (claves foráneas)
const TABLAS = [
  ['AlmuerzosTurno', 'Almuerzos'],
  ['HistorialUbicaciones', 'Puntos GPS del recorrido'],
  ['UbicacionesEnVivo', 'Ubicaciones en vivo'],
  ['AlertasEnviadas', 'Alertas enviadas por supervisores'],
  ['AuditoriaFraudeFacial', 'Alertas de fraude'],
  ['RegistroAsistencia', 'Asistencias (entradas/salidas)'],
];
const CONSERVA = ['Usuarios', 'EstacionesTrabajo', 'CalendarioDias', 'CalendarioExcepciones', 'CalendarioConfig', 'SuscripcionesPush'];

const pool = await sql.connect({ ...dbConfig, requestTimeout: 300000 });
const q = (t) => pool.request().query(t);
try {
  console.log(`🧹 Limpieza de datos de prueba en [${dbConfig.database}] ${confirmar ? '(BORRADO REAL)' : '(SIMULACIÓN: no se cambia nada)'}\n`);

  const existentes = [];
  for (const [tabla, etiqueta] of TABLAS) {
    const e = (await q(`SELECT OBJECT_ID('${tabla}', 'U') AS id`)).recordset[0].id;
    if (!e) { console.log(`• ${etiqueta} (${tabla}): la tabla no existe, se omite.`); continue; }
    const n = (await q(`SELECT COUNT(*) AS n FROM ${tabla}`)).recordset[0].n;
    existentes.push(tabla);
    console.log(`• ${etiqueta} (${tabla}): ${n} registro(s) ${confirmar ? 'a borrar' : 'se borrarían'}`);
  }

  console.log('\nSe conservan:');
  for (const t of CONSERVA) {
    const e = (await q(`SELECT OBJECT_ID('${t}', 'U') AS id`)).recordset[0].id;
    if (!e) continue;
    const n = (await q(`SELECT COUNT(*) AS n FROM ${t}`)).recordset[0].n;
    console.log(`  - ${t}: ${n}`);
  }

  const activos = (await q("SELECT u.codigo_empleado, u.nombre, a.hora_ingreso FROM RegistroAsistencia a JOIN Usuarios u ON u.id = a.usuario_id WHERE a.estado = 'activo'")).recordset;
  if (activos.length) {
    console.log(`\n⚠️ Hay ${activos.length} turno(s) ACTIVO(s) ahora mismo:`);
    for (const a of activos) console.log(`   - ${a.codigo_empleado} ${a.nombre} (entrada ${new Date(a.hora_ingreso).toLocaleString('es-PE')})`);
    console.log('   Deben marcar su salida (o forzarla desde el panel) antes de limpiar.');
    if (confirmar) { console.error('\n❌ No se borró nada.'); process.exitCode = 1; }
  }

  if (!confirmar) {
    console.log('\nNo se cambió nada. Para borrar de verdad:  node service/limpiar-pruebas.mjs --confirmar [--respaldo "RUTA.bak"]');
  } else if (!activos.length) {
    if (rutaRespaldo) {
      console.log(`\n💾 Respaldo de la base en: ${rutaRespaldo} …`);
      await pool.request().input('ruta', sql.NVarChar(500), rutaRespaldo)
        .query(`BACKUP DATABASE [${dbConfig.database.replace(/]/g, ']]')}] TO DISK = @ruta WITH INIT, COMPRESSION`);
      console.log('   Respaldo listo.');
    } else {
      console.log('\n⚠️ Sin respaldo (no usaste --respaldo). Lo borrado no se puede recuperar.');
    }
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const tabla of existentes) await new sql.Request(tx).query(`DELETE FROM ${tabla}`);
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    for (const tabla of existentes) await q(`DBCC CHECKIDENT ('${tabla}', RESEED, 0) WITH NO_INFOMSGS`);
    console.log('\n✅ Listo. Datos de prueba borrados y contadores reiniciados. Reinicia el servidor:  pm2 restart smi-gps');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
