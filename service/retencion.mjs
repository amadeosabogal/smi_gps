// Borrado automático por plazos de conservación (protección de datos personales).
//   RETENCION_FOTOS_DIAS      -> a los N días se BORRAN las fotos de verificación (entrada, salida, almuerzo y alertas de
//                                fraude). La asistencia (horas) y el resto del registro se conservan.
//   RETENCION_REGISTROS_DIAS  -> a los N días se BORRAN los registros completos: asistencias terminadas con sus almuerzos
//                                y recorridos GPS, alertas de fraude y avisos enviados.
//   (Los puntos GPS tienen su propio plazo: RETENCION_UBICACIONES_DIAS.)
// Mínimo 30 días cada uno, para no borrar de más por una configuración equivocada. Vacío = no borrar nunca.
// Nunca se tocan los turnos activos ni la foto de referencia del rostro de un trabajador en actividad.
import sql from 'mssql';

export const MINIMO_DIAS = 30;
const LOTE = 200;

const existe = async (pool, tabla) =>
  Boolean((await pool.request().query(`SELECT OBJECT_ID('${tabla}', 'U') AS id`)).recordset[0].id);
const valido = (d) => Number.isFinite(d) && d >= MINIMO_DIAS;
const cuenta = async (pool, consulta, dias) =>
  (await pool.request().input('d', sql.Int, dias).query(consulta)).recordset[0].n;

/** Cuántos registros vencidos hay (no cambia nada). */
export async function contarVencidos(pool, { fotosDias, registrosDias }) {
  const t = { almuerzos: await existe(pool, 'AlmuerzosTurno'), alertas: await existe(pool, 'AlertasEnviadas') };
  const r = {};
  if (valido(fotosDias)) {
    r.fotosAsistencia = await cuenta(pool, `SELECT COUNT(*) AS n FROM RegistroAsistencia WHERE estado <> 'activo' AND hora_ingreso < DATEADD(DAY, -@d, GETDATE()) AND (foto_ingreso_url IS NOT NULL OR foto_salida_url IS NOT NULL)`, fotosDias);
    r.fotosAlmuerzo = t.almuerzos ? await cuenta(pool, `SELECT COUNT(*) AS n FROM AlmuerzosTurno WHERE inicio_en < DATEADD(DAY, -@d, GETDATE()) AND (foto_inicio_url IS NOT NULL OR foto_fin_url IS NOT NULL)`, fotosDias) : 0;
    r.fotosFraude = await cuenta(pool, `SELECT COUNT(*) AS n FROM AuditoriaFraudeFacial WHERE fecha_intento < DATEADD(DAY, -@d, GETDATE()) AND foto_intento_url IS NOT NULL`, fotosDias);
  }
  if (valido(registrosDias)) {
    r.asistencias = await cuenta(pool, `SELECT COUNT(*) AS n FROM RegistroAsistencia WHERE estado <> 'activo' AND hora_ingreso < DATEADD(DAY, -@d, GETDATE())`, registrosDias);
    r.alertasFraude = await cuenta(pool, `SELECT COUNT(*) AS n FROM AuditoriaFraudeFacial WHERE fecha_intento < DATEADD(DAY, -@d, GETDATE())`, registrosDias);
    r.avisos = t.alertas ? await cuenta(pool, `SELECT COUNT(*) AS n FROM AlertasEnviadas WHERE enviada_en < DATEADD(DAY, -@d, GETDATE())`, registrosDias) : 0;
  }
  return r;
}

// Repite una operación por lotes hasta que ya no afecte filas
async function enLotes(pool, consulta, dias) {
  let total = 0;
  for (let i = 0; i < 100000; i++) {
    const r = await pool.request().input('d', sql.Int, dias).input('lote', sql.Int, LOTE).query(consulta);
    const n = r.recordset?.[0]?.n ?? r.rowsAffected?.at(-1) ?? 0;
    if (!n) break;
    total += n;
  }
  return total;
}

/** Borra lo vencido. Devuelve cuántos registros afectó en cada concepto. */
export async function purgarVencidos(pool, { fotosDias, registrosDias }) {
  const t = { almuerzos: await existe(pool, 'AlmuerzosTurno'), alertas: await existe(pool, 'AlertasEnviadas') };
  const r = {};
  if (valido(fotosDias)) {
    r.fotosAsistencia = await enLotes(pool, `
      UPDATE TOP (@lote) RegistroAsistencia SET foto_ingreso_url = NULL, foto_salida_url = NULL
       WHERE estado <> 'activo' AND hora_ingreso < DATEADD(DAY, -@d, GETDATE()) AND (foto_ingreso_url IS NOT NULL OR foto_salida_url IS NOT NULL);
      SELECT @@ROWCOUNT AS n;`, fotosDias);
    r.fotosAlmuerzo = t.almuerzos ? await enLotes(pool, `
      UPDATE TOP (@lote) AlmuerzosTurno SET foto_inicio_url = NULL, foto_fin_url = NULL
       WHERE inicio_en < DATEADD(DAY, -@d, GETDATE()) AND (foto_inicio_url IS NOT NULL OR foto_fin_url IS NOT NULL);
      SELECT @@ROWCOUNT AS n;`, fotosDias) : 0;
    r.fotosFraude = await enLotes(pool, `
      UPDATE TOP (@lote) AuditoriaFraudeFacial SET foto_intento_url = NULL
       WHERE fecha_intento < DATEADD(DAY, -@d, GETDATE()) AND foto_intento_url IS NOT NULL;
      SELECT @@ROWCOUNT AS n;`, fotosDias);
  }
  if (valido(registrosDias)) {
    // Asistencias terminadas, junto con sus almuerzos y recorridos (una sola transacción por lote)
    r.asistencias = await enLotes(pool, `
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @ids TABLE (id INT PRIMARY KEY);
      INSERT INTO @ids SELECT TOP (@lote) id FROM RegistroAsistencia WHERE estado <> 'activo' AND hora_ingreso < DATEADD(DAY, -@d, GETDATE()) ORDER BY id;
      ${t.almuerzos ? 'DELETE FROM AlmuerzosTurno WHERE asistencia_id IN (SELECT id FROM @ids);' : ''}
      DELETE FROM HistorialUbicaciones WHERE asistencia_id IN (SELECT id FROM @ids);
      UPDATE UbicacionesEnVivo SET asistencia_id = NULL WHERE asistencia_id IN (SELECT id FROM @ids);
      DELETE FROM RegistroAsistencia WHERE id IN (SELECT id FROM @ids);
      DECLARE @n INT = @@ROWCOUNT;
      COMMIT;
      SELECT @n AS n;`, registrosDias);
    r.alertasFraude = await enLotes(pool, `
      DELETE TOP (@lote) FROM AuditoriaFraudeFacial WHERE fecha_intento < DATEADD(DAY, -@d, GETDATE());
      SELECT @@ROWCOUNT AS n;`, registrosDias);
    r.avisos = t.alertas ? await enLotes(pool, `
      DELETE TOP (@lote) FROM AlertasEnviadas WHERE enviada_en < DATEADD(DAY, -@d, GETDATE());
      SELECT @@ROWCOUNT AS n;`, registrosDias) : 0;
  }
  return r;
}
