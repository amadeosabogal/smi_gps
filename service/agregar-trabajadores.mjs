// Da de alta trabajadores nuevos desde un archivo. Para cada uno:
//   - su código de empleado es su DNI (con el DNI y su contraseña ingresa a la app),
//   - se le genera una contraseña (PIN) aleatoria de 6 dígitos, que se muestra UNA sola vez al aplicar,
//   - queda activo, con cargo "Operador de Campo" y listo para registrar su rostro en su primera marcación.
//
// Archivo: una línea por trabajador, "DNI" y "Nombre completo" separados por tabulador, espacio, coma o punto y coma.
//   Si el nombre viene como "APELLIDOS, NOMBRES" se reordena a "Nombres Apellidos".
//
// Uso:   node service/agregar-trabajadores.mjs --archivo=nuevos.txt           SIMULA (no cambia nada)
//        node service/agregar-trabajadores.mjs --archivo=nuevos.txt --apply   da de alta y muestra las contraseñas
// Requisito: haber ejecutado antes  npm run migrate-dni
import fs from 'fs';
import sql from 'mssql';
import { dbConfig } from './config.mjs';
import { hashPinAsync } from './auth.mjs';
import crypto from 'crypto';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const archivo = arg('archivo');
const aplicar = process.argv.includes('--apply');
if (!archivo) {
  console.error('Indica el archivo:  node service/agregar-trabajadores.mjs --archivo=nuevos.txt');
  process.exit(1);
}

const normalizarDni = (v) => String(v ?? '').replace(/[\s.-]/g, '').toUpperCase();
const dniValido = (d) => /^[A-Z0-9]{8,12}$/.test(d);
// "CHAGUA TORES, JORGE LUIS" -> "Jorge Luis Chagua Tores"; sin coma se deja el orden tal cual
const bonito = (s) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
function limpiarNombre(n) {
  const txt = n.replace(/\s+/g, ' ').trim();
  if (txt.includes(',')) {
    const [ap, nom] = txt.split(',').map((x) => x.trim());
    return bonito(`${nom} ${ap}`.trim());
  }
  return bonito(txt);
}

if (!fs.existsSync(archivo)) {
  console.error(`No existe el archivo ${archivo}`);
  process.exit(1);
}
const filas = fs.readFileSync(archivo, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l, i) => {
  // DNI (sin espacios) + separador (tabulador, espacio, ; o ,) + nombre
  const m = l.match(/^([A-Za-z0-9.-]{8,15})\s*[;,]?\s+(.+)$/) || l.match(/^([A-Za-z0-9.-]{8,15})[;,](.+)$/);
  if (!m) return { n: i + 1, error: 'no se entiende la línea (usa: DNI, tabulador o espacio, nombre completo)' };
  return { n: i + 1, dni: normalizarDni(m[1]), nombre: limpiarNombre(m[2]), cargo: 'Operador de Campo' };
});

const pool = await sql.connect({ ...dbConfig, requestTimeout: 120000 });
try {
  const col = (await pool.request().query("SELECT COL_LENGTH('Usuarios', 'dni') AS n")).recordset[0].n;
  if (!col) throw new Error('Falta la columna dni: ejecuta primero  npm run migrate-dni');
  const pinAncho = (await pool.request().query("SELECT COL_LENGTH('Usuarios', 'pin') AS n")).recordset[0].n;
  if (pinAncho !== null && pinAncho < 100) throw new Error('Falta migrar la base de datos: ejecuta  node service/migrate-security.mjs');

  const usuarios = (await pool.request().query('SELECT id, codigo_empleado, nombre, dni, correo FROM Usuarios')).recordset;
  // Para no duplicar a alguien que ya existe con otro código: se compara el nombre sin tildes ni orden
  const clave = (n) => String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-zñ]+/).filter(Boolean).sort().join(' ');
  const porNombre = new Map(usuarios.map((u) => [clave(u.nombre), u]));
  const dnis = new Set(usuarios.flatMap((u) => [u.dni, u.codigo_empleado]).filter(Boolean));
  const correos = new Set(usuarios.map((u) => String(u.correo || '').toLowerCase()));

  const plan = [];
  const problemas = [];
  const vistos = new Set();
  for (const f of filas) {
    if (f.error) { problemas.push(`Línea ${f.n}: ${f.error}`); continue; }
    if (!f.nombre) { problemas.push(`Línea ${f.n}: falta el nombre.`); continue; }
    if (!dniValido(f.dni)) { problemas.push(`Línea ${f.n} (${f.nombre}): DNI inválido "${f.dni}".`); continue; }
    if (vistos.has(f.dni)) { problemas.push(`Línea ${f.n}: el DNI ${f.dni} está repetido en el archivo.`); continue; }
    vistos.add(f.dni);
    if (dnis.has(f.dni)) { console.log(`• ${f.nombre} (${f.dni}): ya existe en el sistema, se omite.`); continue; }
    const parecido = porNombre.get(clave(f.nombre));
    if (parecido) { problemas.push(`Línea ${f.n} (${f.nombre}): ya existe un usuario con ese nombre (código ${parecido.codigo_empleado}). Si es la misma persona, cárgale el DNI con  cargar-dnis.mjs  en vez de crearla de nuevo.`); continue; }
    const correo = `${f.dni.toLowerCase()}@smi.pe`;
    if (correos.has(correo)) { problemas.push(`Línea ${f.n} (${f.nombre}): el correo ${correo} ya está en uso.`); continue; }
    plan.push({ ...f, correo });
  }

  console.log(`\n${aplicar ? '🔧 ALTAS' : '🔎 SIMULACIÓN (no se cambia nada)'} en [${dbConfig.database}]:`);
  for (const x of plan) console.log(`   ${x.dni}  ${x.nombre}  (${x.cargo})`);
  if (problemas.length) {
    console.log('\n⚠️ Problemas:');
    for (const m of problemas) console.log('   - ' + m);
  }

  if (!aplicar) {
    console.log(`\n${plan.length} alta(s) lista(s). Para darlas de alta: node service/agregar-trabajadores.mjs --archivo=${archivo} --apply`);
  } else if (!plan.length) {
    console.log('\nNada que dar de alta.');
  } else {
    const creados = [];
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const x of plan) {
        const pin = String(crypto.randomInt(100000, 999999));
        await new sql.Request(tx)
          .input('codigo', sql.VarChar(50), x.dni).input('dni', sql.VarChar(12), x.dni)
          .input('nombre', sql.NVarChar(150), x.nombre.slice(0, 150)).input('correo', sql.VarChar(150), x.correo)
          .input('pin', sql.VarChar(200), await hashPinAsync(pin)).input('cargo', sql.NVarChar(100), x.cargo.slice(0, 100))
          .query(`INSERT INTO Usuarios (codigo_empleado, dni, nombre, correo, pin, rol, cargo, telefono, activo, facial_enrolado, creado_en)
                  VALUES (@codigo, @dni, @nombre, @correo, @pin, 'trabajador', @cargo, '', 1, 0, GETDATE())`);
        creados.push({ dni: x.dni, nombre: x.nombre, pin });
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    console.log(`\n✅ ${creados.length} trabajador(es) dados de alta. ENTREGA a cada uno su contraseña ahora: no se vuelve a mostrar.\n`);
    console.log('   DNI (usuario)   Contraseña   Nombre');
    for (const c of creados) console.log(`   ${c.dni.padEnd(14)}  ${c.pin}       ${c.nombre}`);
    console.log('\nCada uno ingresa a la app con su DNI y esa contraseña, y registra su rostro en su primera marcación.');
    console.log('Reinicia el servidor:  pm2 restart smi-gps');
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
