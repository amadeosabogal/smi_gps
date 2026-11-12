import sql from 'mssql';
import { dbConfig } from './config.mjs';


async function migrate() {
  const pool = await sql.connect(dbConfig);
  try {
    await pool.request().query(`
      IF COL_LENGTH('RegistroAsistencia', 'foto_ingreso_url') IS NULL
        ALTER TABLE RegistroAsistencia ADD foto_ingreso_url NVARCHAR(MAX) NULL;

      IF COL_LENGTH('RegistroAsistencia', 'foto_salida_url') IS NULL
        ALTER TABLE RegistroAsistencia ADD foto_salida_url NVARCHAR(MAX) NULL;
    `);
    console.log('✅ Columnas de fotos agregadas con éxito a RegistroAsistencia en SQL Server');
  } catch (err) {
    console.error('Error migrando:', err);
  } finally {
    await pool.close();
  }
}

migrate();

