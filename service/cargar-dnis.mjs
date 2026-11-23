// Carga el DNI de los trabajadores desde un archivo CSV. Para cada trabajador:
//   - se guarda su DNI (con él ingresa a la app), y
//   - su código de empleado pasa a ser su DNI (por ejemplo, EMP-106 -> 74027616).
// El historial no se pierde: está ligado al trabajador, no a su código.
//
// Pasos:
//   1) node service/cargar-dnis.mjs --listar                 crea dnis.csv con los trabajadores actuales (columna dni vacía)
//   2) edita dnis.csv y escribe el DNI de cada uno (columna dni)
//   3) node service/cargar-dnis.mjs                          SIMULA: valida y muestra qué cambiaría (no cambia nada)
//   4) node service/cargar-dnis.mjs --apply                  aplica los cambios
//
// Opciones: --archivo=ruta.csv (por defecto dnis.csv en la carpeta actual)
// Requisito: haber ejecutado antes  npm run migrate-dni
import fs from 'fs';
import sql from 'mssql';
import { dbConfig } from './config.mjs';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const archivo = arg('archivo') || 'dnis.csv';
const listar = process.argv.includes('--listar');
const aplicar = process.argv.includes('--apply');

const normalizar = (v) => String(v ?? '').replace(/[\s.-]/g, '').toUpperCase();
const valido = (d) => /^[A-Z0-9]{8,12}$/.test(d);

// Línea CSV simple: separa por coma respetando comillas dobles
function partirLinea(linea) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of linea) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const pool = await sql.connect({ ...dbConfig, requestTimeout: 120000 });
try {
  const col = (await pool.request().query("SELECT COL_LENGTH('Usuarios', 'dni') AS n")).recordset[0].n;
  if (!col) throw new Error('Falta la columna dni: ejecuta primero  npm run migrate-dni');

  if (listar) {
    const r = await pool.request().query("SELECT codigo_empleado, nombre, dni FROM Usuarios WHERE rol = 'trabajador' AND activo = 1 ORDER BY nombre");
    const csv = ['codigo_actual,nombre,dni', ...r.recordset.map((u) => `${u.codigo_empleado},"${String(u.nombre).replace(/"/g, '')}",${u.dni || ''}`)].join('\n') + '\n';
    if (fs.existsSync(archivo)) throw new Error(`${archivo} ya existe: bórralo o usa otro nombre con --archivo=`);
    fs.writeFileSync(archivo, csv, 'utf8');
    console.log(`📝 ${archivo} creado con ${r.recordset.length} trabajador(es). Escribe el DNI de cada uno en la tercera columna y luego ejecuta de nuevo sin --listar.`);
  } else {
    if (!fs.existsSync(archivo)) throw new Error(`No existe ${archivo}. Créalo con  node service/cargar-dnis.mjs --listar`);
    const lineas = fs.readFileSync(archivo, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const filas = lineas.slice(/^codigo/i.test(lineas[0]) ? 1 : 0).map((l, i) => {
      const c = partirLinea(l);
      return { n: i + 2, codigo: c[0], dni: normalizar(c[c.length - 1]) };
    });

    const problemas = [];
    const vistos = new Map();
    const plan = [];
    const usuarios = (await pool.request().query("SELECT id, codigo_empleado, nombre, rol, dni FROM Usuarios")).recordset;
    const porCodigo = new Map(usuarios.map((u) => [u.codigo_empleado, u]));
    const codigosEnUso = new Map(usuarios.map((u) => [u.codigo_empleado, u]));
    const dnisEnUso = new Map(usuarios.filter((u) => u.dni).map((u) => [u.dni, u]));

    for (const f of filas) {
      if (!f.dni) { console.log(`• Línea ${f.n} (${f.codigo}): sin DNI, se omite.`); continue; }
      const u = porCodigo.get(f.codigo);
      if (!u) { problemas.push(`Línea ${f.n}: no existe un trabajador con el código "${f.codigo}".`); continue; }
      if (u.rol !== 'trabajador') { problemas.push(`Línea ${f.n}: ${f.codigo} no es un trabajador.`); continue; }
      if (!valido(f.dni)) { problemas.push(`Línea ${f.n} (${f.codigo}): DNI inválido "${f.dni}" (8 dígitos; o 8 a 12 letras y números).`); continue; }
      if (vistos.has(f.dni)) { problemas.push(`Línea ${f.n}: el DNI ${f.dni} está repetido (también en la línea ${vistos.get(f.dni)}).`); continue; }
      vistos.set(f.dni, f.n);
      const otroDni = dnisEnUso.get(f.dni);
      const otroCodigo = codigosEnUso.get(f.dni);
      if ((otroDni && otroDni.id !== u.id) || (otroCodigo && otroCodigo.id !== u.id)) {
        problemas.push(`Línea ${f.n} (${f.codigo}): el DNI ${f.dni} ya lo usa otro usuario (${(otroDni || otroCodigo).nombre}).`);
        continue;
      }
      plan.push({ id: u.id, nombre: u.nombre, desde: u.codigo_empleado, dni: f.dni });
    }

    console.log(`\n${aplicar ? '🔧 CAMBIOS' : '🔎 SIMULACIÓN (no se cambia nada)'} en [${dbConfig.database}]:`);
    for (const x of plan) console.log(`   ${x.nombre}: código ${x.desde} -> ${x.dni} (DNI ${x.dni})`);
    if (problemas.length) {
      console.log('\n⚠️ Problemas (corrígelos en el archivo y vuelve a ejecutar):');
      for (const m of problemas) console.log('   - ' + m);
    }
    const sinDni = usuarios.filter((u) => u.rol === 'trabajador' && !u.dni && !plan.some((x) => x.id === u.id));
    if (sinDni.length) console.log(`\nℹ️ Trabajadores que seguirán SIN DNI (no podrán ingresar con DNI): ${sinDni.map((u) => `${u.nombre} (${u.codigo_empleado})`).join(', ')}`);

    if (!aplicar) {
      console.log(`\n${plan.length} cambio(s) listo(s). Para aplicarlos: node service/cargar-dnis.mjs --apply${problemas.length ? '  (se aplicarán solo los que no tienen problemas)' : ''}`);
    } else if (!plan.length) {
      console.log('\nNada que aplicar.');
    } else {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        for (const x of plan) {
          await new sql.Request(tx).input('id', sql.Int, x.id).input('dni', sql.VarChar(12), x.dni)
            .query("UPDATE Usuarios SET dni = @dni, codigo_empleado = @dni WHERE id = @id AND rol = 'trabajador'");
        }
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
      console.log(`\n✅ ${plan.length} trabajador(es) actualizados. Reinicia el servidor:  pm2 restart smi-gps`);
    }
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
