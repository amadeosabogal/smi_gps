// Recordatorios automáticos de marcación para los trabajadores en turno:
//   - inicio del almuerzo y salida: a la hora que fije la oficina (lunes a viernes, sábado y domingo);
//   - fin del almuerzo: cuando se cumplen los minutos permitidos desde que el trabajador lo inició.
// Cada aviso se repite una vez a los 15 minutos si todavía no marcó. Viajan por el mismo camino que las alertas del
// supervisor (la app Android los recibe con el rastreo del turno; el navegador, por notificación push).
//
// Las tablas se preparan con:  npm run migrate-recordatorios   (sin ellas todo funciona como antes y no se envía nada).

/** Minutos después de la hora en que se envía cada aviso (el primero y la repetición). */
export const REPETICIONES_MIN = [0, 15];
/** Si el servidor estuvo apagado, un aviso atrasado más de estos minutos ya no se envía. */
export const MARGEN_MIN = 10;

const GRUPOS = ['semana', 'sabado', 'domingo'];
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Sin nada configurado no se envía ningún aviso. */
export const CONFIG_VACIA = Object.freeze({
  finAlmuerzo: false,
  semana: { almuerzo: null, salida: null },
  sabado: { almuerzo: null, salida: null },
  domingo: { almuerzo: null, salida: null },
});

/** Valida lo que envía el panel (o lo guardado). Devuelve la configuración limpia, o null si hay una hora mal escrita. */
export function limpiarConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const limpia = { finAlmuerzo: c.finAlmuerzo === true };
  for (const g of GRUPOS) {
    limpia[g] = {};
    for (const campo of ['almuerzo', 'salida']) {
      const v = c[g]?.[campo];
      if (v === null || v === undefined || v === '') limpia[g][campo] = null;
      else if (typeof v === 'string' && HORA.test(v)) limpia[g][campo] = v;
      else return null;
    }
  }
  return limpia;
}

export const hayAvisos = (c) => c.finAlmuerzo || GRUPOS.some((g) => c[g].almuerzo || c[g].salida);

/** Fecha civil y minutos desde la medianoche en la zona horaria del negocio. */
export function horaLocal(instante, zona) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(instante)
      .map((p) => [p.type, p.value])
  );
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, minutos: Number(partes.hour) * 60 + Number(partes.minute) };
}

const grupoDe = (fecha) => {
  const dia = new Date(`${fecha}T00:00:00Z`).getUTCDay();
  return dia === 0 ? 'domingo' : dia === 6 ? 'sabado' : 'semana';
};
const diaAnterior = (fecha) => new Date(new Date(`${fecha}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
// Número de envío (1 o 2) que corresponde si han pasado `atraso` minutos desde la hora; 0 = ninguno
const envioPara = (atraso) => REPETICIONES_MIN.findIndex((m) => atraso >= m && atraso < m + MARGEN_MIN) + 1;

/**
 * Avisos que corresponden AHORA a un turno activo. Lógica pura (se prueba sin base de datos).
 * ahora: { fecha, minutos } locales. turno: { minutosEnTurno, almuerzos, almuerzoAbierto: { id, minutos } | null,
 * autorizacionesPendientes: [tipo] }. Devuelve [{ clave, mensaje }]; la clave evita enviar dos veces el mismo aviso.
 */
export function avisosPendientes({ config, ahora, turno, almuerzoHabilitado, almuerzoMinutos }) {
  const avisos = [];
  const esperaOficina = (tipo) => (turno.autorizacionesPendientes || []).includes(tipo);

  // Fin del almuerzo: cuenta desde que el trabajador lo inició
  const abierto = turno.almuerzoAbierto;
  if (almuerzoHabilitado && config.finAlmuerzo && abierto && !esperaOficina('almuerzo_fin')) {
    const n = envioPara(abierto.minutos - almuerzoMinutos);
    if (n) {
      avisos.push({
        clave: `fin_almuerzo:${abierto.id}:${n}`,
        mensaje:
          n === 1
            ? `Recordatorio: se cumplieron sus ${almuerzoMinutos} minutos de almuerzo. Marque en la app que terminó su almuerzo.`
            : 'Recordatorio: todavía no marca el fin de su almuerzo. Márquelo en la app.',
      });
    }
  }

  // Avisos por hora fija. Se revisa también el día anterior para las horas cercanas a la medianoche.
  for (const [fecha, desfase] of [[ahora.fecha, 0], [diaAnterior(ahora.fecha), 1440]]) {
    const horas = config[grupoDe(fecha)];
    for (const campo of ['almuerzo', 'salida']) {
      const hora = horas[campo];
      if (!hora) continue;
      const [h, m] = hora.split(':').map(Number);
      const atraso = ahora.minutos + desfase - (h * 60 + m);
      const n = envioPara(atraso);
      // Solo a quien ya estaba en turno cuando llegó la hora (no a quien entró después)
      if (!n || turno.minutosEnTurno <= atraso) continue;

      if (campo === 'almuerzo') {
        if (!almuerzoHabilitado || turno.almuerzos > 0 || esperaOficina('almuerzo_inicio')) continue;
        avisos.push({
          clave: `almuerzo:${fecha}:${n}`,
          mensaje:
            n === 1
              ? `Recordatorio: son las ${hora}, hora de almuerzo. Cuando salga a almorzar, márquelo en la app.`
              : 'Recordatorio: todavía no marca el inicio de su almuerzo. Si ya salió a almorzar, márquelo en la app.',
        });
      } else {
        if (esperaOficina('salida')) continue;
        avisos.push({
          clave: `salida:${fecha}:${n}`,
          mensaje:
            n === 1
              ? `Recordatorio: su hora de salida es a las ${hora}. Al terminar, marque su salida en la app.`
              : `Recordatorio: todavía no marca su salida (hora de salida: ${hora}). Si ya terminó, márquela en la app.`,
        });
      }
    }
  }
  return avisos;
}

export function registrarRecordatorios(app, d) {
  const { sql } = d;
  let habilitado = false;
  let enviando = false;

  async function comprobarTabla() {
    try {
      const p = await d.getPool();
      const r = await p.request().query(
        "SELECT OBJECT_ID('RecordatoriosConfig', 'U') AS t, COL_LENGTH('AlertasEnviadas', 'recordatorio') AS c"
      );
      habilitado = Boolean(r.recordset[0].t && r.recordset[0].c);
      if (!habilitado) console.warn('⚠️ Los recordatorios de marcación aún no están habilitados: ejecuta  npm run migrate-recordatorios  y reinicia.');
    } catch (err) {
      console.warn('No se pudo comprobar las tablas de recordatorios:', err.message);
    }
  }

  async function leerConfig(p) {
    const r = await p.request().query("SELECT valor FROM RecordatoriosConfig WHERE clave = 'horarios'");
    try {
      return limpiarConfig(JSON.parse(r.recordset[0].valor)) || CONFIG_VACIA;
    } catch {
      return CONFIG_VACIA; // sin configurar todavía
    }
  }

  const respuesta = (config) => ({
    habilitado,
    config,
    almuerzoHabilitado: d.almuerzoHabilitado(),
    almuerzoMinutos: d.config.almuerzoMinutos,
  });

  app.get('/api/reminders/config', d.requireAuth(d.ROLES_STAFF), async (req, res) => {
    try {
      if (!habilitado) return res.json(respuesta(CONFIG_VACIA));
      res.json(respuesta(await leerConfig(await d.getPool())));
    } catch (err) {
      d.fail(res, err);
    }
  });

  app.put('/api/reminders/config', d.requireAuth(d.ROLES_ADMIN), async (req, res) => {
    try {
      if (!habilitado) {
        return res.status(503).json({ error: 'Los recordatorios aún no están habilitados en el servidor: ejecuta  npm run migrate-recordatorios' });
      }
      const config = limpiarConfig(req.body);
      if (!config) return res.status(400).json({ error: 'Revise las horas: deben tener el formato 13:00.' });
      const p = await d.getPool();
      await p.request().input('v', sql.NVarChar(2000), JSON.stringify(config)).input('por', sql.Int, req.user.id).query(`
        UPDATE RecordatoriosConfig SET valor = @v, actualizado_por = @por, actualizado_en = GETDATE() WHERE clave = 'horarios';
        IF @@ROWCOUNT = 0 INSERT INTO RecordatoriosConfig (clave, valor, actualizado_por) VALUES ('horarios', @v, @por);
      `);
      console.log(`⏰ Admin ${req.user.id} guardó los recordatorios: ${JSON.stringify(config)}`);
      res.json(respuesta(config));
    } catch (err) {
      d.fail(res, err);
    }
  });

  /** Se ejecuta cada minuto: busca los turnos activos a los que les toca un aviso y se lo envía. */
  async function enviarPendientes(instante = new Date()) {
    if (!habilitado || !d.alertasListas() || enviando) return 0;
    enviando = true;
    let enviados = 0;
    try {
      const p = await d.getPool();
      const config = await leerConfig(p);
      if (!hayAvisos(config)) return 0;
      const conAlmuerzo = d.almuerzoHabilitado();

      const turnos = (await p.request().query(`
        SELECT a.id AS asistencia_id, a.usuario_id, DATEDIFF(MINUTE, a.hora_ingreso, GETDATE()) AS minutos_turno
          FROM RegistroAsistencia a JOIN Usuarios u ON u.id = a.usuario_id
         WHERE a.estado = 'activo' AND u.activo = 1`)).recordset;
      if (!turnos.length) return 0;

      const almuerzos = new Map();
      if (conAlmuerzo) {
        const r = await p.request().query(`
          SELECT x.asistencia_id, COUNT(*) AS total,
                 MAX(CASE WHEN x.fin_en IS NULL THEN x.id END) AS abierto_id,
                 MAX(CASE WHEN x.fin_en IS NULL THEN DATEDIFF(MINUTE, x.inicio_en, GETDATE()) END) AS minutos_abierto
            FROM AlmuerzosTurno x JOIN RegistroAsistencia a ON a.id = x.asistencia_id
           WHERE a.estado = 'activo'
           GROUP BY x.asistencia_id`);
        for (const f of r.recordset) almuerzos.set(f.asistencia_id, f);
      }

      // A quien ya pidió autorización a la oficina no se le insiste con esa marcación
      const esperando = new Map();
      if (d.autorizacionesHabilitadas()) {
        const r = await p.request().input('v', sql.Int, d.vigenciaAutorizacionMin).query(`
          SELECT usuario_id, tipo FROM SolicitudesMarcacion
           WHERE estado = 'pendiente' AND creada_en > DATEADD(MINUTE, -@v, GETDATE())`);
        for (const f of r.recordset) esperando.set(f.usuario_id, [...(esperando.get(f.usuario_id) || []), f.tipo]);
      }

      const ahora = horaLocal(instante, d.config.zonaHoraria);
      for (const t of turnos) {
        const alm = almuerzos.get(t.asistencia_id);
        const avisos = avisosPendientes({
          config,
          ahora,
          almuerzoHabilitado: conAlmuerzo,
          almuerzoMinutos: d.config.almuerzoMinutos,
          turno: {
            minutosEnTurno: t.minutos_turno,
            almuerzos: alm?.total || 0,
            almuerzoAbierto: alm?.abierto_id ? { id: alm.abierto_id, minutos: alm.minutos_abierto } : null,
            autorizacionesPendientes: esperando.get(t.usuario_id),
          },
        });
        for (const aviso of avisos) {
          try {
            // Se registra una sola vez por turno y aviso. "enviado_por" = el propio trabajador marca que es automático.
            const r = await p.request()
              .input('u', sql.Int, t.usuario_id).input('a', sql.Int, t.asistencia_id)
              .input('k', sql.VarChar(40), aviso.clave).input('m', sql.NVarChar(300), aviso.mensaje)
              .query(`
                INSERT INTO AlertasEnviadas (usuario_id, enviado_por, mensaje, asistencia_id, recordatorio)
                OUTPUT INSERTED.id
                SELECT @u, @u, @m, @a, @k
                 WHERE NOT EXISTS (SELECT 1 FROM AlertasEnviadas WHERE asistencia_id = @a AND recordatorio = @k)
                   AND EXISTS (SELECT 1 FROM RegistroAsistencia WHERE id = @a AND estado = 'activo')`);
            const id = r.recordset[0]?.id;
            if (!id) continue; // ya se había enviado
            enviados++;
            await d.entregar(p, { alertaId: id, usuarioId: t.usuario_id, mensaje: aviso.mensaje });
          } catch (err) {
            console.error(`Recordatorio ${aviso.clave} (usuario ${t.usuario_id}):`, err.message);
          }
        }
      }
      if (enviados) console.log(`⏰ ${enviados} recordatorio(s) de marcación enviado(s).`);
    } catch (err) {
      console.error('Error al enviar los recordatorios de marcación:', err.message);
    } finally {
      enviando = false;
    }
    return enviados;
  }

  /** El trabajador ya marcó: un recordatorio que aún no llegó a su celular no debe aparecer después. */
  async function darPorAtendidos(usuarioId) {
    if (!habilitado) return;
    try {
      const p = await d.getPool();
      await p.request().input('u', sql.Int, usuarioId).query(
        'UPDATE AlertasEnviadas SET leida_en = GETDATE() WHERE usuario_id = @u AND recordatorio IS NOT NULL AND leida_en IS NULL'
      );
    } catch (err) {
      console.warn('No se pudo cerrar los recordatorios pendientes:', err.message);
    }
  }

  setInterval(() => enviarPendientes(), 60 * 1000).unref();

  return { comprobarTabla, enviarPendientes, darPorAtendidos };
}
