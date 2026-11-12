import sql from 'mssql';
import { dbConfig } from './config.mjs';
import { hashPin } from './auth.mjs';

// ⚠️ Este script BORRA y recrea todas las tablas. Solo para instalaciones nuevas.
if (!process.argv.includes('--force-destroy-all-data')) {
  console.error('⛔ init-db BORRA TODAS las tablas y datos de la base ' + dbConfig.database + '.');
  console.error('   Si realmente quieres hacerlo, ejecútalo con: node service/init-db.mjs --force-destroy-all-data');
  process.exit(1);
}

const DB_NAME = dbConfig.database;


async function initDatabaseSpanish() {
  console.log(`📡 Conectando a SQL Server para migrar a nombres en ESPAÑOL [${DB_NAME}]...`);

  const pool = await sql.connect(dbConfig);
  console.log(`Conectado a [${DB_NAME}]. Eliminando tablas antiguas si existen...`);

  try {
    // Drop old English tables if exist
    await pool.request().query(`
      IF OBJECT_ID('LocationHistory', 'U') IS NOT NULL DROP TABLE LocationHistory;
      IF OBJECT_ID('LiveLocations', 'U') IS NOT NULL DROP TABLE LiveLocations;
      IF OBJECT_ID('AttendanceLogs', 'U') IS NOT NULL DROP TABLE AttendanceLogs;
      IF OBJECT_ID('Workstations', 'U') IS NOT NULL DROP TABLE Workstations;
      IF OBJECT_ID('Users', 'U') IS NOT NULL DROP TABLE Users;

      -- También eliminar tablas en español si ya existieran para recrearlas limpias
      IF OBJECT_ID('HistorialUbicaciones', 'U') IS NOT NULL DROP TABLE HistorialUbicaciones;
      IF OBJECT_ID('UbicacionesEnVivo', 'U') IS NOT NULL DROP TABLE UbicacionesEnVivo;
      IF OBJECT_ID('RegistroAsistencia', 'U') IS NOT NULL DROP TABLE RegistroAsistencia;
      IF OBJECT_ID('EstacionesTrabajo', 'U') IS NOT NULL DROP TABLE EstacionesTrabajo;
      IF OBJECT_ID('Usuarios', 'U') IS NOT NULL DROP TABLE Usuarios;
    `);

    console.log('Creando tablas 100% en ESPAÑOL...');

    // 1. Tabla: Usuarios
    await pool.request().query(`
      CREATE TABLE Usuarios (
        id INT IDENTITY(1,1) PRIMARY KEY,
        codigo_empleado VARCHAR(50) UNIQUE NOT NULL,
        nombre NVARCHAR(150) NOT NULL,
        correo VARCHAR(150) UNIQUE NOT NULL,
        pin VARCHAR(200) NULL, -- hash scrypt
        rol VARCHAR(20) DEFAULT 'trabajador', -- 'administrador', 'supervisor', 'trabajador'
        telefono VARCHAR(30) NULL,
        cargo NVARCHAR(100) NULL,
        avatar_url NVARCHAR(255) NULL,
        activo BIT DEFAULT 1,
        creado_en DATETIME2 DEFAULT GETDATE()
      );
      PRINT 'Tabla Usuarios creada.';
    `);

    // 2. Tabla: EstacionesTrabajo
    await pool.request().query(`
      CREATE TABLE EstacionesTrabajo (
        id INT IDENTITY(1,1) PRIMARY KEY,
        codigo VARCHAR(50) UNIQUE NOT NULL,
        nombre NVARCHAR(150) NOT NULL,
        latitud FLOAT NOT NULL,
        longitud FLOAT NOT NULL,
        radio_metros FLOAT DEFAULT 50.0,
        color VARCHAR(20) DEFAULT '#3B82F6',
        descripcion NVARCHAR(255) NULL,
        activo BIT DEFAULT 1,
        creado_en DATETIME2 DEFAULT GETDATE()
      );
      PRINT 'Tabla EstacionesTrabajo creada.';
    `);

    // 3. Tabla: RegistroAsistencia
    await pool.request().query(`
      CREATE TABLE RegistroAsistencia (
        id INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        hora_ingreso DATETIME2 NOT NULL,
        hora_salida DATETIME2 NULL,
        latitud_ingreso FLOAT NOT NULL,
        longitud_ingreso FLOAT NOT NULL,
        precision_ingreso FLOAT NULL,
        estacion_ingreso_id INT NULL FOREIGN KEY REFERENCES EstacionesTrabajo(id),
        latitud_salida FLOAT NULL,
        longitud_salida FLOAT NULL,
        precision_salida FLOAT NULL,
        estacion_salida_id INT NULL FOREIGN KEY REFERENCES EstacionesTrabajo(id),
        foto_ingreso_url NVARCHAR(MAX) NULL,
        foto_salida_url NVARCHAR(MAX) NULL,
        estado VARCHAR(20) DEFAULT 'activo', -- 'activo', 'completado'
        horas_totales FLOAT NULL,
        notas NVARCHAR(500) NULL,
        creado_en DATETIME2 DEFAULT GETDATE()
      );
      PRINT 'Tabla RegistroAsistencia creada.';
    `);

    // 4. Tabla: UbicacionesEnVivo
    await pool.request().query(`
      CREATE TABLE UbicacionesEnVivo (
        id INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL UNIQUE FOREIGN KEY REFERENCES Usuarios(id),
        asistencia_id INT NULL FOREIGN KEY REFERENCES RegistroAsistencia(id),
        latitud FLOAT NOT NULL,
        longitud FLOAT NOT NULL,
        precision FLOAT NULL,
        velocidad FLOAT NULL,
        rumbo FLOAT NULL,
        estacion_actual_id INT NULL FOREIGN KEY REFERENCES EstacionesTrabajo(id),
        dentro_de_estacion BIT DEFAULT 0,
        activo BIT DEFAULT 1,
        ultimo_ping DATETIME2 DEFAULT GETDATE()
      );
      PRINT 'Tabla UbicacionesEnVivo creada.';
    `);

    // 5. Tabla: HistorialUbicaciones
    await pool.request().query(`
      CREATE TABLE HistorialUbicaciones (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES Usuarios(id),
        asistencia_id INT NOT NULL FOREIGN KEY REFERENCES RegistroAsistencia(id),
        latitud FLOAT NOT NULL,
        longitud FLOAT NOT NULL,
        precision FLOAT NULL,
        estacion_id INT NULL FOREIGN KEY REFERENCES EstacionesTrabajo(id),
        fecha_registro DATETIME2 DEFAULT GETDATE()
      );
      PRINT 'Tabla HistorialUbicaciones creada.';
    `);

    // Inserción de Datos Iniciales en Español
    console.log('Sembrando datos en español...');

    // PINs iniciales: se hashean y se muestran UNA vez; cámbialos con: node service/set-pin.mjs <CODIGO> <PIN>
    const seedUsuarios = [
      ['ADM-001', 'Administrador General', 'admin@smi.pe', 'administrador', 'Gerente de Operaciones', '+51 987 654 321'],
      ['EMP-101', 'Carlos Mendoza Ramos', 'carlos.mendoza@smi.pe', 'trabajador', 'Operador de Maquinaria Pesada', '+51 912 345 678'],
      ['EMP-102', 'Valeria Quispe Huamán', 'valeria.quispe@smi.pe', 'trabajador', 'Técnica de Mantenimiento', '+51 923 456 789'],
      ['EMP-103', 'Jorge Luis Benítez', 'jorge.benitez@smi.pe', 'trabajador', 'Supervisor de Ensamble', '+51 934 567 890'],
      ['EMP-104', 'Ana Lucía Torres', 'ana.torres@smi.pe', 'trabajador', 'Logística y Almacén', '+51 945 678 901'],
    ];
    const crypto = await import('crypto');
    for (const [codigo, nombre, correo, rol, cargo, telefono] of seedUsuarios) {
      const pinInicial = String(crypto.randomInt(100000, 999999));
      await pool.request()
        .input('codigo', sql.VarChar(50), codigo)
        .input('nombre', sql.NVarChar(150), nombre)
        .input('correo', sql.VarChar(150), correo)
        .input('pin', sql.VarChar(200), hashPin(pinInicial))
        .input('rol', sql.VarChar(20), rol)
        .input('cargo', sql.NVarChar(100), cargo)
        .input('telefono', sql.VarChar(30), telefono)
        .query('INSERT INTO Usuarios (codigo_empleado, nombre, correo, pin, rol, cargo, telefono) VALUES (@codigo, @nombre, @correo, @pin, @rol, @cargo, @telefono)');
      console.log(`   PIN inicial de ${codigo}: ${pinInicial}`);
    }

    await pool.request().query(`
      INSERT INTO EstacionesTrabajo (codigo, nombre, latitud, longitud, radio_metros, color, descripcion) VALUES
      ('EST-01', 'Taller Principal y Soldadura', -12.046374, -77.042793, 50.0, '#EF4444', 'Área de soldadura estructural y armado'),
      ('EST-02', 'Almacén Central y Despacho', -12.045600, -77.043500, 60.0, '#10B981', 'Zona de recepción de materiales y racks'),
      ('EST-03', 'Línea de Ensamble y Calidad', -12.047100, -77.042100, 45.0, '#3B82F6', 'Control de calidad y empaque final'),
      ('EST-04', 'Oficinas Técnicas y Operaciones', -12.046000, -77.041500, 40.0, '#F59E0B', 'Supervisión y control de proyectos');
    `);

    console.log('✅ Base de datos recreada exitosamente con todas las tablas y columnas en ESPAÑOL!');

    // Show summary
    const usuarios = await pool.request().query('SELECT id, codigo_empleado, nombre, rol, cargo FROM Usuarios');
    console.log('\nTabla [Usuarios]:');
    console.table(usuarios.recordset);

    const estaciones = await pool.request().query('SELECT id, codigo, nombre, radio_metros, latitud, longitud FROM EstacionesTrabajo');
    console.log('\nTabla [EstacionesTrabajo]:');
    console.table(estaciones.recordset);

  } catch (err) {
    console.error('❌ Error migrando esquema:', err);
  } finally {
    await pool.close();
  }
}

initDatabaseSpanish();
