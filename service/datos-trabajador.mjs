// Derechos del trabajador sobre sus datos: copia completa (acceso) y eliminación total (cancelación).
import sql from 'mssql';

const existe = async (pool, tabla) =>
  Boolean((await pool.request().query(`SELECT OBJECT_ID('${tabla}', 'U') AS id`)).recordset[0].id);

const COLUMNAS_FOTO = ['foto_ingreso_url', 'foto_salida_url', 'foto_inicio_url', 'foto_fin_url', 'foto_intento_url', 'foto_referencia_url', 'foto_solicitud_url'];

// Sin fotos: se indica solo si existen (las fotos pesan mucho; se piden aparte con fotos=1)
function sinFotos(fila) {
  const f = { ...fila };
  for (const c of COLUMNAS_FOTO) if (c in f) f[c] = f[c] ? '[foto guardada: descargue con fotos incluidas para verla]' : null;
  return f;
}

/** Todos los datos de un trabajador, listos para entregárselos (JSON). */
export async function exportarDatos(pool, usuarioId, { fotos = false } = {}) {
  const q = async (tabla, consulta) => {
    if (!(await existe(pool, tabla))) return [];
    const r = await pool.request().input('u', sql.Int, usuarioId).query(consulta);
    return r.recordset.map((fila) => (fotos ? fila : sinFotos(fila)));
  };
  const tieneDni = Boolean((await pool.request().query("SELECT COL_LENGTH('Usuarios', 'dni') AS n")).recordset[0].n);
  const usuario = (await pool.request().input('u', sql.Int, usuarioId).query(
    `SELECT id, codigo_empleado, ${tieneDni ? 'dni, ' : ''}nombre, correo, rol, cargo, telefono, activo, facial_enrolado, creado_en, foto_referencia_url
       FROM Usuarios WHERE id = @u`
  )).recordset[0];
  if (!usuario) return null;
  return {
    generadoEn: new Date().toISOString(),
    incluyeFotos: Boolean(fotos),
    nota: 'Copia de los datos personales que la aplicación de asistencia tiene de este trabajador. No incluye el PIN (se guarda cifrado e ilegible) ni la huella numérica del rostro.',
    usuario: fotos ? usuario : sinFotos(usuario),
    asistencias: await q('RegistroAsistencia', 'SELECT * FROM RegistroAsistencia WHERE usuario_id = @u ORDER BY id'),
    almuerzos: await q('AlmuerzosTurno', 'SELECT * FROM AlmuerzosTurno WHERE usuario_id = @u ORDER BY id'),
    recorridoGps: await q('HistorialUbicaciones', 'SELECT * FROM HistorialUbicaciones WHERE usuario_id = @u ORDER BY id'),
    ultimaUbicacion: await q('UbicacionesEnVivo', 'SELECT * FROM UbicacionesEnVivo WHERE usuario_id = @u'),
    avisosRecibidos: await q('AlertasEnviadas', 'SELECT id, mensaje, enviada_en, leida_en FROM AlertasEnviadas WHERE usuario_id = @u ORDER BY id'),
    alertasDeSeguridad: await q('AuditoriaFraudeFacial', 'SELECT * FROM AuditoriaFraudeFacial WHERE usuario_id = @u ORDER BY id'),
    solicitudesDeAutorizacion: await q('SolicitudesMarcacion', 'SELECT * FROM SolicitudesMarcacion WHERE usuario_id = @u ORDER BY id'),
    autorizacionesDeDiasNoLaborables: await q('CalendarioExcepciones', 'SELECT fecha, motivo, creado_en FROM CalendarioExcepciones WHERE usuario_id = @u ORDER BY fecha'),
    aceptacionesDelAviso: await q('AceptacionesPrivacidad', 'SELECT * FROM AceptacionesPrivacidad WHERE usuario_id = @u ORDER BY id'),
  };
}

/** Baja: desactiva al trabajador y borra su rostro (foto de referencia y huella) y sus suscripciones de notificaciones. */
export async function darDeBaja(pool, usuarioId) {
  await pool.request().input('u', sql.Int, usuarioId).query(
    `UPDATE Usuarios SET activo = 0, descriptor_facial = NULL, foto_referencia_url = NULL, facial_enrolado = 0 WHERE id = @u`
  );
  if (await existe(pool, 'SuscripcionesPush')) await pool.request().input('u', sql.Int, usuarioId).query('DELETE FROM SuscripcionesPush WHERE usuario_id = @u');
  await pool.request().input('u', sql.Int, usuarioId).query('UPDATE UbicacionesEnVivo SET activo = 0 WHERE usuario_id = @u');
  if (await existe(pool, 'SolicitudesMarcacion')) {
    await pool.request().input('u', sql.Int, usuarioId).query(
      "UPDATE SolicitudesMarcacion SET estado = 'anulada', resuelta_en = GETDATE() WHERE usuario_id = @u AND estado = 'pendiente'"
    );
  }
}

/** Elimina TODO rastro del trabajador: sus asistencias, recorridos, almuerzos, alertas y su propio usuario. No se puede deshacer. */
export async function eliminarTodo(pool, usuarioId) {
  const tablas = [];
  for (const [tabla, filtro] of [
    ['AlmuerzosTurno', 'usuario_id = @u'],
    ['SolicitudesMarcacion', 'usuario_id = @u'],
    ['HistorialUbicaciones', 'usuario_id = @u'],
    ['UbicacionesEnVivo', 'usuario_id = @u'],
    ['AlertasEnviadas', 'usuario_id = @u OR enviado_por = @u'],
    ['AuditoriaFraudeFacial', 'usuario_id = @u'],
    ['SuscripcionesPush', 'usuario_id = @u'],
    ['CalendarioExcepciones', 'usuario_id = @u'],
    ['AceptacionesPrivacidad', 'usuario_id = @u'],
    ['RegistroAsistencia', 'usuario_id = @u'],
    ['Usuarios', 'id = @u'],
  ]) {
    if (await existe(pool, tabla)) tablas.push([tabla, filtro]);
  }
  const tx = new sql.Transaction(pool);
  await tx.begin();
  const borrados = {};
  try {
    for (const [tabla, filtro] of tablas) {
      const r = await new sql.Request(tx).input('u', sql.Int, usuarioId).query(`DELETE FROM ${tabla} WHERE ${filtro}`);
      borrados[tabla] = r.rowsAffected[0] || 0;
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return borrados;
}
