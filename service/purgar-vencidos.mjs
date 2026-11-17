// Borra a pedido lo que superó los plazos de conservación (el servidor también lo hace solo cada 24 h).
//
// Uso:   node service/purgar-vencidos.mjs --fotos=365 --registros=1095           (SOLO cuenta; no borra nada)
//        node service/purgar-vencidos.mjs --fotos=365 --registros=1095 --apply   (borra)
//
//   --fotos=N      borra las fotos de verificación de más de N días (la asistencia se conserva)
//   --registros=N  borra asistencias terminadas (con almuerzos y recorrido), alertas de fraude y avisos de más de N días
// Mínimo 30 días cada uno. Es irreversible: haz un respaldo antes.
import sql from 'mssql';
import { dbConfig } from './config.mjs';
import { contarVencidos, purgarVencidos, MINIMO_DIAS } from './retencion.mjs';

const num = (nombre) => {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a ? Number(a.split('=')[1]) : NaN;
};
const fotosDias = num('fotos');
const registrosDias = num('registros');
const aplicar = process.argv.includes('--apply');

if (!(fotosDias >= MINIMO_DIAS) && !(registrosDias >= MINIMO_DIAS)) {
  console.error(`Indica al menos uno: --fotos=N o --registros=N (mínimo ${MINIMO_DIAS} días).`);
  process.exit(1);
}

const pool = await sql.connect({ ...dbConfig, requestTimeout: 600000 });
try {
  const cfg = { fotosDias, registrosDias };
  const cuenta = await contarVencidos(pool, cfg);
  console.log(`🧹 Vencidos en [${dbConfig.database}]:`);
  for (const [k, v] of Object.entries(cuenta)) console.log(`   • ${k}: ${v}`);
  if (!aplicar) {
    console.log('\nNo se borró nada. Para borrar de verdad agrega --apply');
  } else {
    const r = await purgarVencidos(pool, cfg);
    console.log('\n✅ Borrado:');
    for (const [k, v] of Object.entries(r)) console.log(`   • ${k}: ${v}`);
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
