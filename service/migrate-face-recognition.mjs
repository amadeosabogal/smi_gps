import sql from 'mssql';
import { dbConfig } from './config.mjs';


async function migrate() {
  try {
    console.log('🔄 Conectando a SQL Server [' + dbConfig.database + ']...');
    const pool = await sql.connect(dbConfig);
    console.log('✅ Conectado exitosamente.');

    // 1. Columnas en Usuarios para biometría facial
    console.log('🛠️ Actualizando tabla Usuarios con campos biométricos...');
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Usuarios') AND name = 'foto_referencia_url')
      BEGIN
        ALTER TABLE Usuarios ADD foto_referencia_url NVARCHAR(MAX) NULL;
        PRINT 'Columna foto_referencia_url añadida a Usuarios.';
      END

      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Usuarios') AND name = 'descriptor_facial')
      BEGIN
        ALTER TABLE Usuarios ADD descriptor_facial NVARCHAR(MAX) NULL;
        PRINT 'Columna descriptor_facial añadida a Usuarios.';
      END

      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Usuarios') AND name = 'facial_enrolado')
      BEGIN
        ALTER TABLE Usuarios ADD facial_enrolado BIT NOT NULL DEFAULT 0;
        PRINT 'Columna facial_enrolado añadida a Usuarios.';
      END
    `);

    // 2. Columnas en RegistroAsistencia para auditoría de coincidencia
    console.log('🛠️ Actualizando tabla RegistroAsistencia con campos de auditoría facial...');
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('RegistroAsistencia') AND name = 'similitud_facial')
      BEGIN
        ALTER TABLE RegistroAsistencia ADD similitud_facial FLOAT NULL;
        PRINT 'Columna similitud_facial añadida a RegistroAsistencia.';
      END

      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('RegistroAsistencia') AND name = 'verificacion_facial_exitosa')
      BEGIN
        ALTER TABLE RegistroAsistencia ADD verificacion_facial_exitosa BIT NULL DEFAULT 1;
        PRINT 'Columna verificacion_facial_exitosa añadida a RegistroAsistencia.';
      END

      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('RegistroAsistencia') AND name = 'metodo_validacion')
      BEGIN
        ALTER TABLE RegistroAsistencia ADD metodo_validacion VARCHAR(40) NULL DEFAULT 'facial_biometrico';
        PRINT 'Columna metodo_validacion añadida a RegistroAsistencia.';
      END
    `);

    // 3. Tabla AuditoriaFraudeFacial para registrar intentos de suplantación
    console.log('🛠️ Creando tabla AuditoriaFraudeFacial si no existe...');
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID('AuditoriaFraudeFacial') AND type in (N'U'))
      BEGIN
        CREATE TABLE AuditoriaFraudeFacial (
          id INT IDENTITY(1,1) PRIMARY KEY,
          usuario_id INT NOT NULL,
          fecha_intento DATETIME NOT NULL DEFAULT GETDATE(),
          tipo_evento VARCHAR(50) NOT NULL, -- 'SUPLANTACION_ROSTRO', 'PRUEBA_VIDA_FALLIDA', 'ROSTRO_NO_DETECTADO'
          foto_intento_url NVARCHAR(MAX) NULL,
          similitud_obtenida FLOAT NULL,
          latitud FLOAT NULL,
          longitud FLOAT NULL,
          precision FLOAT NULL,
          notas NVARCHAR(255) NULL,
          CONSTRAINT FK_AuditoriaFraude_Usuario FOREIGN KEY (usuario_id) REFERENCES Usuarios(id)
        );
        PRINT 'Tabla AuditoriaFraudeFacial creada.';
      END
    `);

    console.log('🎉 Migración de base de datos para Reconocimiento Facial completada con éxito.');
    await pool.close();
  } catch (err) {
    console.error('❌ Error en migración:', err);
    process.exit(1);
  }
}

migrate();

