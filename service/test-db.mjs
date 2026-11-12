import sql from 'mssql';
import { dbConfig } from './config.mjs';


async function testConnection() {
  console.log(`Intentando conectar a SQL Server ${dbConfig.server}:${dbConfig.port}...`);
  try {
    const pool = await sql.connect({ ...dbConfig, database: undefined });
    console.log('✅ Conexión exitosa a SQL Server!');
    
    // List databases
    const result = await pool.request().query('SELECT name FROM sys.databases');
    console.log('Bases de datos existentes:');
    result.recordset.forEach(r => console.log(' - ' + r.name));

    await pool.close();
  } catch (err) {
    console.error('❌ Error de conexión:', err.message);
    if (err.originalError) {
      console.error('Detalles:', err.originalError.message);
    }
  }
}

testConnection();

