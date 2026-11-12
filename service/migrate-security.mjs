// Migración de seguridad (idempotente):
//   1. Amplía la columna Usuarios.pin para poder guardar hashes (scrypt).
//   2. Convierte los PIN guardados en texto plano a hash.
//   3. Avisa de quién sigue usando un PIN por defecto/débil.
//
// Uso:   node service/migrate-security.mjs            (aplica los cambios)
//        node service/migrate-security.mjs --dry-run   (solo muestra qué haría)
import sql from 'mssql';
import { dbConfig } from './config.mjs';
import { hashPin, isHashedPin, verifyPin } from './auth.mjs';

const dryRun = process.argv.includes('--dry-run');
const WEAK_PINS = ['1234', '0000', '1111', '123456', 'admin123', 'admin', 'password'];

async function migrate() {
  console.log(`🔐 Migración de seguridad en [${dbConfig.database}] ${dryRun ? '(SIMULACIÓN, no se cambia nada)' : ''}`);
  // El ALTER TABLE necesita esperar a que terminen las lecturas en curso (p. ej. consultas con fotos grandes)
  const pool = await sql.connect({ ...dbConfig, requestTimeout: 180000 });

  try {
    // 1. Ampliar columna pin
    const col = await pool.request().query(`
      SELECT COL_LENGTH('Usuarios', 'pin') AS bytes,
             (SELECT TOP 1 dc.name FROM sys.default_constraints dc
                JOIN sys.columns c ON c.default_object_id = dc.object_id
               WHERE c.object_id = OBJECT_ID('Usuarios') AND c.name = 'pin') AS default_name
    `);
    const { bytes, default_name: defaultName } = col.recordset[0];

    if (bytes !== null && bytes < 200) {
      console.log(`• Columna pin mide ${bytes} bytes: se ampliará a VARCHAR(200).`);
      if (!dryRun) {
        if (defaultName) {
          await pool.request().query(`ALTER TABLE Usuarios DROP CONSTRAINT [${defaultName}]`);
          console.log(`  - Eliminado el valor por defecto '${defaultName}' (el PIN ya no debe tener uno).`);
        }
        await pool.request().query('ALTER TABLE Usuarios ALTER COLUMN pin VARCHAR(200) NULL');
        console.log('  ✓ Columna ampliada.');
      }
    } else {
      console.log('• La columna pin ya es lo bastante ancha.');
    }

    // 2. Hashear PIN en texto plano
    const usuarios = await pool.request().query('SELECT id, codigo_empleado, rol, pin FROM Usuarios');
    let aHashear = 0;
    const debiles = [];

    for (const u of usuarios.recordset) {
      if (!u.pin) {
        debiles.push(`${u.codigo_empleado} (sin PIN)`);
        continue;
      }
      if (WEAK_PINS.some((w) => verifyPin(w, u.pin))) debiles.push(`${u.codigo_empleado} (${u.rol})`);

      if (!isHashedPin(u.pin)) {
        aHashear += 1;
        if (!dryRun) {
          await pool
            .request()
            .input('id', sql.Int, u.id)
            .input('pin', sql.VarChar(200), hashPin(u.pin))
            .query('UPDATE Usuarios SET pin = @pin WHERE id = @id');
        }
      }
    }
    console.log(`• PIN en texto plano ${dryRun ? 'por convertir' : 'convertidos a hash'}: ${aHashear}`);

    // 3. Avisos
    if (debiles.length) {
      console.log('\n⚠️  Estos usuarios todavía usan un PIN por defecto o débil. CÁMBIALOS antes de producción:');
      debiles.forEach((d) => console.log(`   - ${d}`));
      console.log('   Comando: node service/set-pin.mjs <CODIGO_EMPLEADO> <NUEVO_PIN>');
    } else {
      console.log('\n✅ No se detectaron PIN por defecto.');
    }
    console.log(dryRun ? '\n(Simulación terminada: no se modificó nada)' : '\n✅ Migración de seguridad completada.');
  } catch (err) {
    console.error('❌ Error en la migración:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.close();
  }
}

migrate();
