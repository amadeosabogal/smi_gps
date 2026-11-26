// Autorización de la oficina: cuando un trabajador no logra la prueba de vida, pide que la oficina autorice su
// marcación (entrada, salida o almuerzo). El rostro se compara igual con el registrado: si no coincide, no se crea la
// solicitud. La oficina ve la foto junto a la de referencia y aprueba o rechaza desde el panel. Al aprobar, el servidor
// registra la marcación con la HORA DE LA SOLICITUD y queda anotado quién la autorizó.
//
// La tabla se crea con:  npm run migrate-autorizaciones   (sin ella todo funciona como antes).

/** Minutos que una solicitud puede esperar respuesta. */
export const VIGENCIA_MIN = 30;
/** Fallos de la prueba de vida que debe haber registrados para poder pedir autorización... */
export const FALLOS_MINIMOS = 3;
/** ...en los últimos tantos minutos. */
export const VENTANA_FALLOS_MIN = 15;

const NOMBRE_TIPO = { entrada: 'Entrada', salida: 'Salida', almuerzo_inicio: 'Inicio de almuerzo', almuerzo_fin: 'Fin de almuerzo' };

/**
 * ¿Se puede pedir autorización ahora? Lógica pura (se prueba sin base de datos).
 * Devuelve null si se puede, o { status, codigo, error } si no.
 */
export function revisarSolicitud({ tipo, hayTurno, enAlmuerzo = false, almuerzosUsados = 0, almuerzosMaximo = 1, fallos, sinVerificacion }) {
  const no = (codigo, error, status = 400) => ({ status, codigo, error });
  if (!sinVerificacion && fallos < FALLOS_MINIMOS) {
    return no('POCOS_INTENTOS', 'Antes de pedir autorización, intente la verificación. Si falla 3 veces podrá solicitarla.', 409);
  }
  if (tipo === 'entrada') return hayTurno ? no('YA_HAY_TURNO', 'Ya existe un turno activo para este trabajador') : null;
  if (!hayTurno) return no('SIN_TURNO', 'No hay un turno activo');
  if (tipo === 'almuerzo_inicio') {
    if (enAlmuerzo) return no('YA_EN_ALMUERZO', 'Ya está en su almuerzo');
    if (almuerzosUsados >= almuerzosMaximo) return no('ALMUERZO_YA_USADO', 'Ya registró su almuerzo en este turno');
  }
  if (tipo === 'almuerzo_fin' && !enAlmuerzo) return no('NO_EN_ALMUERZO', 'No está en su almuerzo');
  return null;
}

// Mensajes cuando, al aprobar, la situación del trabajador ya cambió
const AL_APROBAR = {
  NO_PENDIENTE: 'La solicitud ya no está pendiente: venció, se canceló o ya fue resuelta.',
  YA_HAY_TURNO: 'El trabajador ya tiene un turno activo: no se registró otra entrada.',
  SIN_TURNO: 'El trabajador ya no tiene un turno activo que corresponda a esta solicitud.',
  YA_EN_ALMUERZO: 'El trabajador ya tiene un almuerzo en curso.',
  ALMUERZO_YA_USADO: 'El trabajador ya registró su almuerzo en este turno.',
  NO_EN_ALMUERZO: 'El trabajador no tiene un almuerzo en curso que corresponda a esta solicitud.',
};

export function registrarAutorizaciones(app, d) {
  const { sql } = d;
  let habilitado = false;

  async function comprobarTabla() {
    try {
      const p = await d.getPool();
      const r = await p.request().query("SELECT OBJECT_ID('SolicitudesMarcacion', 'U') AS id");
      habilitado = Boolean(r.recordset[0].id);
      if (!habilitado) console.warn('⚠️ La autorización de la oficina aún no está habilitada: ejecuta  npm run migrate-autorizaciones  y reinicia.');
    } catch (err) {
      console.warn('No se pudo comprobar la tabla de solicitudes:', err.message);
    }
  }

  const noDisponible = (res) => {
    if (habilitado) return false;
    res.status(503).json({ error: 'La autorización de la oficina aún no está habilitada en el servidor.', codigo: 'AUTORIZACION_NO_DISPONIBLE' });
    return true;
  };

  const vencerAntiguas = (p) =>
    p.request().input('v', sql.Int, VIGENCIA_MIN).query(
      "UPDATE SolicitudesMarcacion SET estado = 'vencida', resuelta_en = GETDATE() WHERE estado = 'pendiente' AND creada_en < DATEADD(MINUTE, -@v, GETDATE())"
    );

  const COLUMNAS_PROPIAS = `s.id, s.tipo, s.estado, s.creada_en, s.motivo_rechazo,
    CASE WHEN s.estado = 'pendiente' AND DATEDIFF(SECOND, GETDATE(), DATEADD(MINUTE, @v, s.creada_en)) > 0
         THEN DATEDIFF(SECOND, GETDATE(), DATEADD(MINUTE, @v, s.creada_en)) ELSE 0 END AS segundos_restantes`;

  async function ultimaDe(p, usuarioId) {
    const r = await p.request().input('u', sql.Int, usuarioId).input('v', sql.Int, VIGENCIA_MIN).query(`
      SELECT TOP 1 ${COLUMNAS_PROPIAS} FROM SolicitudesMarcacion s
       WHERE s.usuario_id = @u AND s.creada_en > DATEADD(HOUR, -12, GETDATE()) ORDER BY s.id DESC`);
    return r.recordset[0] || null;
  }

  /** El trabajador marcó por la vía normal: su solicitud pendiente de ese tipo ya no hace falta. */
  async function anularPendientes(usuarioId, tipo) {
    if (!habilitado) return;
    try {
      const p = await d.getPool();
      const r = await p.request().input('u', sql.Int, usuarioId).input('t', sql.VarChar(20), tipo).query(
        "UPDATE SolicitudesMarcacion SET estado = 'anulada', resuelta_en = GETDATE() WHERE usuario_id = @u AND tipo = @t AND estado = 'pendiente'"
      );
      if (r.rowsAffected?.[0]) d.emitStaff('authorization_event', { accion: 'anulada', usuarioId, tipo });
    } catch (err) {
      console.warn('No se pudo anular la solicitud pendiente:', err.message);
    }
  }

  // ----- Trabajador -----
  app.get('/api/authorization/me', d.requireAuth(d.ROLES_WORKER), async (req, res) => {
    try {
      if (!habilitado) return res.json({ habilitado: false, solicitud: null });
      const p = await d.getPool();
      await vencerAntiguas(p);
      res.json({ habilitado: true, solicitud: await ultimaDe(p, req.user.id) });
    } catch (err) {
      d.fail(res, err);
    }
  });

  app.post('/api/authorization/request', d.requireAuth(d.ROLES_WORKER), async (req, res) => {
    try {
      if (noDisponible(res)) return;
      const { tipo, descriptor, foto, latitud, longitud, precision, antiguedadMs, sinVerificacion } = req.body || {};
      const live = d.parseDescriptor(descriptor);
      if (!live || !d.validPhoto(foto) || !d.TIPOS_VERIFICACION.includes(tipo)) {
        return res.status(400).json({ error: 'Datos biométricos inválidos' });
      }
      const userId = req.user.id;
      const lockKey = `face:${userId}`;
      const blocked = d.faceFailLimiter.blockedFor(lockKey);
      if (blocked) {
        return res.status(429).json({ error: `Demasiados intentos fallidos. Intente en ${Math.ceil(blocked / 60)} min o comuníquese con la oficina.` });
      }

      const p = await d.getPool();
      const u = (await p.request().input('id', sql.Int, userId)
        .query('SELECT descriptor_facial, facial_enrolado, activo FROM Usuarios WHERE id = @id')).recordset[0];
      if (!u || !u.activo) return res.status(401).json({ error: 'Usuario no disponible' });
      const enrolled = u.facial_enrolado ? d.parseDescriptor(u.descriptor_facial) : null;
      if (!enrolled) return res.status(409).json({ error: 'Su rostro aún no está registrado. Pida a la oficina que lo registre.', needsEnrol: true });

      // Situación del turno
      const turno = await d.turnoActivoDe(p, userId);
      const esAlmuerzo = tipo === 'almuerzo_inicio' || tipo === 'almuerzo_fin';
      let enAlmuerzo = false;
      let almuerzosUsados = 0;
      if (esAlmuerzo) {
        if (!d.almuerzoHabilitado()) return res.status(503).json({ error: 'El almuerzo aún no está habilitado en el servidor.', codigo: 'ALMUERZO_NO_DISPONIBLE' });
        if (turno) {
          if (d.esOtroDispositivo(turno, d.dispositivoDe(req))) return res.status(409).json({ error: d.MSG_OTRO_DISPOSITIVO, codigo: 'OTRO_DISPOSITIVO' });
          const a = (await p.request().input('a', sql.Int, turno.id)
            .query('SELECT COUNT(*) AS total, SUM(CASE WHEN fin_en IS NULL THEN 1 ELSE 0 END) AS abiertos FROM AlmuerzosTurno WHERE asistencia_id = @a')).recordset[0];
          enAlmuerzo = a.abiertos > 0;
          almuerzosUsados = a.total;
        }
      }
      const fallos = (await p.request().input('u', sql.Int, userId).input('m', sql.Int, VENTANA_FALLOS_MIN).query(
        "SELECT COUNT(*) AS n FROM AuditoriaFraudeFacial WHERE usuario_id = @u AND tipo_evento = 'FALLA_PRUEBA_VIDA' AND fecha_intento >= DATEADD(MINUTE, -@m, GETDATE())"
      )).recordset[0].n;
      const impedimento = revisarSolicitud({
        tipo, hayTurno: Boolean(turno), enAlmuerzo, almuerzosUsados, almuerzosMaximo: d.config.almuerzosPorTurno,
        fallos, sinVerificacion: sinVerificacion === true,
      });
      if (impedimento) return res.status(impedimento.status).json({ error: impedimento.error, codigo: impedimento.codigo });

      // Ubicación: la entrada exige la misma precisión que una marcación normal; la salida la lleva si la hay
      const tieneCoords = latitud !== undefined && latitud !== null && longitud !== undefined && longitud !== null;
      if (tieneCoords && !d.validCoords(latitud, longitud)) return res.status(400).json({ error: 'Coordenadas inválidas' });
      if (tipo === 'entrada') {
        if (!tieneCoords) return res.status(400).json({ error: 'latitud y longitud válidas son requeridas' });
        if (!d.isNum(precision) || precision <= 0 || precision > d.config.gpsMaxPrecisionCheckin) {
          return res.status(400).json({
            codigo: 'GPS_IMPRECISO',
            error: `Su ubicación no es lo bastante precisa. Se requiere ±${d.config.gpsMaxPrecisionCheckin} m o menos.`,
          });
        }
        if (d.isNum(antiguedadMs) && antiguedadMs > d.config.gpsMaxAgeMs) {
          return res.status(400).json({ codigo: 'GPS_DESACTUALIZADO', error: 'La ubicación está desactualizada. Espere a que el GPS se actualice e intente de nuevo.' });
        }
      }

      // Identidad: el mismo criterio que la marcación normal
      const distancia = d.euclideanDistance(live, enrolled);
      const similarity = d.similarityFromDistance(distancia);
      if (!(distancia < d.config.faceMatchThreshold)) {
        d.faceFailLimiter.fail(lockKey);
        await d.registrarFraude({
          usuarioId: userId,
          tipoEvento: 'SUPLANTACION_ROSTRO',
          foto,
          similitud: similarity,
          notas: `Pidió autorización con un rostro que no coincide (Similitud: ${similarity}%)`,
        });
        return res.json({ isMatch: false, similarity, solicitud: null });
      }

      await vencerAntiguas(p);
      const previa = await ultimaDe(p, userId);
      if (previa?.estado === 'pendiente') {
        if (previa.tipo === tipo) return res.json({ isMatch: true, similarity, solicitud: previa });
        await p.request().input('id', sql.Int, previa.id)
          .query("UPDATE SolicitudesMarcacion SET estado = 'anulada', resuelta_en = GETDATE() WHERE id = @id AND estado = 'pendiente'");
      }

      const geo = tieneCoords ? await d.detectarEstacionTrabajo(latitud, longitud) : { estacionId: null };
      try {
        await p.request()
          .input('u', sql.Int, userId)
          .input('t', sql.VarChar(20), tipo)
          .input('foto', sql.NVarChar(sql.MAX), foto)
          .input('sim', sql.Float, similarity)
          .input('sinv', sql.Bit, sinVerificacion === true ? 1 : 0)
          .input('fallos', sql.Int, fallos)
          .input('lat', sql.Float, tieneCoords ? latitud : null)
          .input('lng', sql.Float, tieneCoords ? longitud : null)
          .input('acc', sql.Float, tieneCoords ? d.optNum(precision) : null)
          .input('est', sql.Int, geo.estacionId)
          .input('disp', sql.VarChar(64), d.dispositivoDe(req))
          .query(`
            INSERT INTO SolicitudesMarcacion (usuario_id, tipo, foto_solicitud_url, similitud, sin_verificacion, fallos,
              latitud, longitud, precision_m, estacion_id, dispositivo_id)
            VALUES (@u, @t, @foto, @sim, @sinv, @fallos, @lat, @lng, @acc, @est, @disp)`);
      } catch (err) {
        if (!d.esDuplicado(err)) throw err; // dos toques seguidos: ya quedó una pendiente
      }
      console.log(`🙋 [AUTORIZACIÓN] Usuario ${userId} pide autorización (${tipo}, similitud ${similarity}%).`);
      d.emitStaff('authorization_event', { accion: 'nueva', usuarioId: userId, tipo });
      res.json({ isMatch: true, similarity, solicitud: await ultimaDe(p, userId) });
    } catch (err) {
      d.fail(res, err);
    }
  });

  app.post('/api/authorization/:id/cancel', d.requireAuth(d.ROLES_WORKER), async (req, res) => {
    try {
      if (noDisponible(res)) return;
      const id = d.idParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Solicitud inválida' });
      const p = await d.getPool();
      const r = await p.request().input('id', sql.Int, id).input('u', sql.Int, req.user.id).query(
        "UPDATE SolicitudesMarcacion SET estado = 'anulada', resuelta_en = GETDATE() WHERE id = @id AND usuario_id = @u AND estado = 'pendiente'"
      );
      if (r.rowsAffected?.[0]) d.emitStaff('authorization_event', { accion: 'anulada', usuarioId: req.user.id });
      res.json({ exito: true });
    } catch (err) {
      d.fail(res, err);
    }
  });

  // ----- Oficina (solo administradores) -----
  app.get('/api/authorization/list', d.requireAuth(d.ROLES_ADMIN), async (req, res) => {
    try {
      if (!habilitado) return res.json({ habilitado: false, pendientes: [], resueltas: [] });
      const p = await d.getPool();
      await vencerAntiguas(p);
      const consulta = (filtro, orden, top) =>
        p.request().input('v', sql.Int, VIGENCIA_MIN).query(`
          SELECT TOP ${top} ${COLUMNAS_PROPIAS}, s.usuario_id, u.nombre AS nombre_usuario, u.codigo_empleado, u.cargo,
                 s.similitud, s.latitud, s.longitud, s.precision_m AS [precision], e.nombre AS estacion_nombre,
                 s.sin_verificacion, s.fallos, CASE WHEN s.foto_solicitud_url IS NULL THEN 0 ELSE 1 END AS tiene_foto,
                 s.resuelta_en, r.nombre AS resuelta_por_nombre
            FROM SolicitudesMarcacion s
            JOIN Usuarios u ON u.id = s.usuario_id
            LEFT JOIN Usuarios r ON r.id = s.resuelta_por
            LEFT JOIN EstacionesTrabajo e ON e.id = s.estacion_id
           WHERE ${filtro} ORDER BY ${orden}`);
      const pendientes = (await consulta("s.estado = 'pendiente'", 's.creada_en ASC', 100)).recordset;
      const resueltas = (await consulta("s.estado <> 'pendiente'", 's.id DESC', 30)).recordset;
      res.json({ habilitado: true, pendientes, resueltas });
    } catch (err) {
      d.fail(res, err);
    }
  });

  app.get('/api/photos/authorization/:id', d.requireAuth(d.ROLES_ADMIN), async (req, res) => {
    try {
      if (!habilitado) return res.status(404).json({ error: 'Foto no disponible' });
      const id = d.idParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Solicitud inválida' });
      const p = await d.getPool();
      const r = await p.request().input('id', sql.Int, id).query('SELECT foto_solicitud_url AS foto FROM SolicitudesMarcacion WHERE id = @id');
      d.enviarFoto(res, r.recordset[0]?.foto);
    } catch (err) {
      d.fail(res, err);
    }
  });

  app.post('/api/authorization/:id/approve', d.requireAuth(d.ROLES_ADMIN), async (req, res) => {
    try {
      if (noDisponible(res)) return;
      const id = d.idParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Solicitud inválida' });
      const p = await d.getPool();
      const s = (await p.request().input('id', sql.Int, id).query(`
        SELECT s.usuario_id, s.tipo, u.nombre, u.activo FROM SolicitudesMarcacion s JOIN Usuarios u ON u.id = s.usuario_id WHERE s.id = @id`)).recordset[0];
      if (!s) return res.status(404).json({ error: 'Solicitud no encontrada' });
      if (!s.activo) return res.status(409).json({ error: 'El trabajador está dado de baja.' });

      const quien = (await p.request().input('id', sql.Int, req.user.id)
        .query('SELECT nombre, codigo_empleado FROM Usuarios WHERE id = @id')).recordset[0];
      const admin = quien ? `${quien.codigo_empleado} ${quien.nombre}` : `usuario ${req.user.id}`;
      const nota = `${NOMBRE_TIPO[s.tipo]} autorizada por la oficina (${admin})`.slice(0, 200);

      const r = await p.request()
        .input('id', sql.Int, id)
        .input('admin', sql.Int, req.user.id)
        .input('v', sql.Int, VIGENCIA_MIN)
        .input('nota', sql.NVarChar(200), nota)
        .input('max', sql.Int, d.config.almuerzosPorTurno)
        .query(sqlAprobar(s.tipo, { dispositivo: d.dispositivoHabilitado(), almuerzo: d.almuerzoHabilitado() }));
      const fin = r.recordset?.[0];
      if (fin?.resultado !== 'OK') {
        return res.status(409).json({ error: AL_APROBAR[fin?.resultado] || 'No se pudo aprobar la solicitud.', codigo: fin?.resultado });
      }

      d.limpiarCaches(s.usuario_id);
      console.log(`✅ [AUTORIZACIÓN] ${admin} aprobó la solicitud ${id} (${s.tipo}) del usuario ${s.usuario_id}.`);
      const fecha = new Date().toISOString();
      if (s.tipo === 'entrada' || s.tipo === 'salida') {
        d.emitStaff('attendance_event', { tipo: s.tipo === 'entrada' ? 'CHECK_IN' : 'CHECK_OUT', usuarioId: s.usuario_id, fecha });
      } else {
        d.emitStaff('almuerzo_event', { tipo: s.tipo === 'almuerzo_inicio' ? 'INICIO' : 'FIN', usuarioId: s.usuario_id, asistenciaId: fin.asistencia_id, fecha });
      }
      d.emitStaff('authorization_event', { accion: 'aprobada', usuarioId: s.usuario_id, tipo: s.tipo });
      res.json({ exito: true, trabajador: s.nombre });
    } catch (err) {
      if (d.esDuplicado(err)) return res.status(409).json({ error: AL_APROBAR.YA_HAY_TURNO, codigo: 'YA_HAY_TURNO' });
      d.fail(res, err);
    }
  });

  app.post('/api/authorization/:id/reject', d.requireAuth(d.ROLES_ADMIN), async (req, res) => {
    try {
      if (noDisponible(res)) return;
      const id = d.idParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Solicitud inválida' });
      const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
      if (motivo.length < 3 || motivo.length > 200) return res.status(400).json({ error: 'Indique el motivo del rechazo (entre 3 y 200 caracteres)' });
      const p = await d.getPool();
      const r = await p.request().input('id', sql.Int, id).input('admin', sql.Int, req.user.id).input('m', sql.NVarChar(200), motivo).query(`
        UPDATE SolicitudesMarcacion SET estado = 'rechazada', resuelta_en = GETDATE(), resuelta_por = @admin, motivo_rechazo = @m
        OUTPUT INSERTED.usuario_id
         WHERE id = @id AND estado = 'pendiente'`);
      if (!r.recordset.length) return res.status(409).json({ error: AL_APROBAR.NO_PENDIENTE, codigo: 'NO_PENDIENTE' });
      d.emitStaff('authorization_event', { accion: 'rechazada', usuarioId: r.recordset[0].usuario_id });
      res.json({ exito: true });
    } catch (err) {
      d.fail(res, err);
    }
  });

  return { comprobarTabla, estaHabilitado: () => habilitado, anularPendientes };
}

/**
 * Lote SQL que aprueba una solicitud y registra la marcación en UNA sola transacción: si la situación ya cambió, no
 * queda nada a medias. Devuelve una fila { resultado: 'OK' | código, asistencia_id }.
 * Parámetros: @id, @admin, @v (minutos de vigencia), @nota, @max (almuerzos por turno).
 */
export function sqlAprobar(tipo, { dispositivo, almuerzo }) {
  const salir = (codigo) => `BEGIN ROLLBACK TRANSACTION; SELECT '${codigo}' AS resultado, CAST(NULL AS INT) AS asistencia_id; RETURN; END;`;
  const marcar = {
    entrada: `
      IF EXISTS (SELECT 1 FROM RegistroAsistencia WITH (UPDLOCK, HOLDLOCK) WHERE usuario_id = @u AND estado = 'activo') ${salir('YA_HAY_TURNO')}
      INSERT INTO RegistroAsistencia (usuario_id, hora_ingreso, latitud_ingreso, longitud_ingreso, precision_ingreso,
        estacion_ingreso_id, foto_ingreso_url, similitud_facial, verificacion_facial_exitosa, metodo_validacion, estado, notas${dispositivo ? ', dispositivo_id' : ''})
      SELECT usuario_id, creada_en, latitud, longitud, precision_m, estacion_id, foto_solicitud_url, similitud, 1,
        'autorizacion_oficina', 'activo', @nota${dispositivo ? ', dispositivo_id' : ''}
        FROM SolicitudesMarcacion WHERE id = @id;
      SET @a = SCOPE_IDENTITY();
      IF EXISTS (SELECT 1 FROM UbicacionesEnVivo WHERE usuario_id = @u)
      BEGIN
        UPDATE v SET asistencia_id = @a, latitud = s.latitud, longitud = s.longitud, precision = s.precision_m,
               estacion_actual_id = s.estacion_id, dentro_de_estacion = CASE WHEN s.estacion_id IS NULL THEN 0 ELSE 1 END,
               activo = 1, ultimo_ping = GETDATE()
          FROM UbicacionesEnVivo v JOIN SolicitudesMarcacion s ON s.id = @id WHERE v.usuario_id = @u;
      END
      ELSE
      BEGIN
        INSERT INTO UbicacionesEnVivo (usuario_id, asistencia_id, latitud, longitud, precision, estacion_actual_id, dentro_de_estacion, activo, ultimo_ping)
        SELECT usuario_id, @a, latitud, longitud, precision_m, estacion_id, CASE WHEN estacion_id IS NULL THEN 0 ELSE 1 END, 1, GETDATE()
          FROM SolicitudesMarcacion WHERE id = @id;
      END;
      INSERT INTO HistorialUbicaciones (usuario_id, asistencia_id, latitud, longitud, precision, estacion_id, fecha_registro)
      SELECT usuario_id, @a, latitud, longitud, precision_m, estacion_id, creada_en FROM SolicitudesMarcacion WHERE id = @id;`,
    salida: `
      SELECT @a = id FROM RegistroAsistencia WITH (UPDLOCK) WHERE usuario_id = @u AND estado = 'activo' AND hora_ingreso <= @hora;
      IF @a IS NULL ${salir('SIN_TURNO')}
      UPDATE r SET hora_salida = @hora, latitud_salida = s.latitud, longitud_salida = s.longitud, precision_salida = s.precision_m,
             estacion_salida_id = s.estacion_id, foto_salida_url = s.foto_solicitud_url, similitud_facial = s.similitud,
             verificacion_facial_exitosa = 1, estado = 'completado',
             horas_totales = ROUND(DATEDIFF(MINUTE, r.hora_ingreso, @hora) / 60.0, 2),
             notas = LEFT(ISNULL(r.notas + N' · ', N'') + @nota, 500)
        FROM RegistroAsistencia r JOIN SolicitudesMarcacion s ON s.id = @id WHERE r.id = @a;
      UPDATE UbicacionesEnVivo SET activo = 0, ultimo_ping = GETDATE() WHERE usuario_id = @u;
      ${almuerzo ? "UPDATE AlmuerzosTurno SET fin_en = CASE WHEN inicio_en > @hora THEN inicio_en ELSE @hora END, cierre = 'salida' WHERE asistencia_id = @a AND fin_en IS NULL;" : ''}`,
    almuerzo_inicio: `
      SELECT @a = id FROM RegistroAsistencia WITH (UPDLOCK) WHERE usuario_id = @u AND estado = 'activo' AND hora_ingreso <= @hora;
      IF @a IS NULL ${salir('SIN_TURNO')}
      IF EXISTS (SELECT 1 FROM AlmuerzosTurno WHERE asistencia_id = @a AND fin_en IS NULL) ${salir('YA_EN_ALMUERZO')}
      IF (SELECT COUNT(*) FROM AlmuerzosTurno WHERE asistencia_id = @a) >= @max ${salir('ALMUERZO_YA_USADO')}
      INSERT INTO AlmuerzosTurno (asistencia_id, usuario_id, inicio_en, similitud_inicio, foto_inicio_url, latitud_inicio, longitud_inicio)
      SELECT @a, s.usuario_id, s.creada_en, s.similitud, s.foto_solicitud_url, v.latitud, v.longitud
        FROM SolicitudesMarcacion s
        LEFT JOIN UbicacionesEnVivo v ON v.usuario_id = s.usuario_id AND v.asistencia_id = @a
       WHERE s.id = @id;`,
    almuerzo_fin: `
      SELECT @a = id FROM RegistroAsistencia WITH (UPDLOCK) WHERE usuario_id = @u AND estado = 'activo';
      IF @a IS NULL ${salir('SIN_TURNO')}
      UPDATE x SET fin_en = @hora, similitud_fin = s.similitud, foto_fin_url = s.foto_solicitud_url,
             latitud_fin = v.latitud, longitud_fin = v.longitud, cierre = 'trabajador'
        FROM AlmuerzosTurno x
        JOIN SolicitudesMarcacion s ON s.id = @id
        LEFT JOIN UbicacionesEnVivo v ON v.usuario_id = s.usuario_id AND v.asistencia_id = @a
       WHERE x.asistencia_id = @a AND x.fin_en IS NULL AND x.inicio_en <= @hora;
      IF @@ROWCOUNT = 0 ${salir('NO_EN_ALMUERZO')}`,
  }[tipo];
  if (!marcar) throw new Error(`Tipo de solicitud desconocido: ${tipo}`);

  return `
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @u INT, @hora DATETIME2, @a INT;
    UPDATE SolicitudesMarcacion SET estado = 'aprobada', resuelta_en = GETDATE(), resuelta_por = @admin,
           @u = usuario_id, @hora = creada_en
     WHERE id = @id AND estado = 'pendiente' AND creada_en >= DATEADD(MINUTE, -@v, GETDATE());
    IF @@ROWCOUNT = 0 ${salir('NO_PENDIENTE')}
    ${marcar}
    UPDATE SolicitudesMarcacion SET asistencia_id = @a WHERE id = @id;
    COMMIT TRANSACTION;
    SELECT 'OK' AS resultado, @a AS asistencia_id;`;
}
