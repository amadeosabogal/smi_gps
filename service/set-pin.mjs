// Cambia el PIN/clave de un usuario (se guarda hasheado).
// Uso: node service/set-pin.mjs <CODIGO_EMPLEADO> <NUEVO_PIN>
//   Trabajadores: 4 a 6 dígitos.  Administradores/supervisores: mínimo 8 caracteres.
import sql from 'mssql';
import { dbConfig } from './config.mjs';
import { hashPin } from './auth.mjs';

const [codigo, nuevoPin] = process.argv.slice(2);
if (!codigo || !nuevoPin) {
  console.error('Uso: node service/set-pin.mjs <CODIGO_EMPLEADO> <NUEVO_PIN>');
  process.exit(1);
}

const pool = await sql.connect(dbConfig);
try {
  const r = await pool.request().input('codigo', sql.VarChar(50), codigo)
    .query('SELECT id, rol, nombre FROM Usuarios WHERE codigo_empleado = @codigo');
  if (!r.recordset.length) {
    console.error(`❌ No existe el usuario ${codigo}`);
    process.exit(1);
  }
  const { id, rol, nombre } = r.recordset[0];

  if (rol === 'trabajador' && !/^\d{4,6}$/.test(nuevoPin)) {
    console.error('❌ El PIN de un trabajador debe tener entre 4 y 6 dígitos.');
    process.exit(1);
  }
  if (rol !== 'trabajador' && nuevoPin.length < 8) {
    console.error('❌ La clave de administrador/supervisor debe tener al menos 8 caracteres.');
    process.exit(1);
  }

  await pool.request().input('id', sql.Int, id).input('pin', sql.VarChar(200), hashPin(nuevoPin))
    .query('UPDATE Usuarios SET pin = @pin WHERE id = @id');
  console.log(`✅ PIN actualizado para ${nombre} (${codigo}).`);
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
