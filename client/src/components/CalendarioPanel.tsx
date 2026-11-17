import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarOff, CalendarCheck, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import type { CalendarioRespuesta, DiaCalendario } from '../types';

interface Trabajador {
  id: number;
  nombre: string;
  codigo_empleado: string;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Se muestran de lunes a domingo; el número es el que usa el servidor (0 = domingo)
const SEMANA = [
  { n: 1, corto: 'Lun', largo: 'Lunes' },
  { n: 2, corto: 'Mar', largo: 'Martes' },
  { n: 3, corto: 'Mié', largo: 'Miércoles' },
  { n: 4, corto: 'Jue', largo: 'Jueves' },
  { n: 5, corto: 'Vie', largo: 'Viernes' },
  { n: 6, corto: 'Sáb', largo: 'Sábado' },
  { n: 0, corto: 'Dom', largo: 'Domingo' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const primerDia = (anio: number, mes: number) => `${anio}-${pad(mes)}-01`; // mes 1-12
const ultimoDia = (anio: number, mes: number) => `${anio}-${pad(mes)}-${pad(new Date(Date.UTC(anio, mes, 0)).getUTCDate())}`;
const fechaLarga = (f: string) => {
  const [y, m, d] = f.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// Cómo se ve cada día en la cuadrícula
function estiloDia(d: DiaCalendario) {
  if (d.laborable && d.decision === true) return 'border-green-400 bg-green-50 text-green-900'; // habilitado a propósito
  if (!d.laborable && d.decision === false) return 'border-red-300 bg-red-50 text-red-900';        // bloqueado a propósito
  if (!d.laborable) return 'border-amber-300 bg-amber-50 text-amber-900';                          // bloqueado por regla (feriado/semanal)
  return 'border-slate-200 bg-white text-slate-800';
}

export const CalendarioPanel: React.FC<{ trabajadores: Trabajador[] }> = ({ trabajadores }) => {
  const [mes, setMes] = useState<{ anio: number; mes: number } | null>(null);
  const [datos, setDatos] = useState<CalendarioRespuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [seleccion, setSeleccion] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [trabajadorSel, setTrabajadorSel] = useState<number | ''>('');
  const [libres, setLibres] = useState<number[]>([]);
  const [libresSucios, setLibresSucios] = useState(false);
  const sucioRef = useRef(false); // si el administrador está editando los días libres, una recarga no los pisa
  const marcarSucio = (v: boolean) => { sucioRef.current = v; setLibresSucios(v); };

  const cargar = useCallback(async (m: { anio: number; mes: number }) => {
    setCargando(true);
    try {
      const r = await api.getCalendario(primerDia(m.anio, m.mes), ultimoDia(m.anio, m.mes));
      setDatos(r);
      setError(null);
      setLibres((prev) => (sucioRef.current ? prev : r.diasLibres));
    } catch (e: any) {
      setError(e.message || 'No se pudo cargar el calendario');
    } finally {
      setCargando(false);
    }
  }, []);

  // Mes inicial: el de "hoy" según la zona horaria del servidor
  useEffect(() => {
    if (mes) return;
    const hoy = new Date();
    setMes({ anio: hoy.getFullYear(), mes: hoy.getMonth() + 1 });
  }, [mes]);
  useEffect(() => {
    if (mes) cargar(mes);
  }, [mes, cargar]);

  // Si el servidor dice qué día es hoy, el mes inicial se ajusta una sola vez
  const [ajustado, setAjustado] = useState(false);
  useEffect(() => {
    if (!datos || ajustado) return;
    setAjustado(true);
    const [y, m] = datos.hoy.split('-').map(Number);
    if (mes && (mes.anio !== y || mes.mes !== m)) setMes({ anio: y, mes: m });
  }, [datos, ajustado, mes]);

  const diaSel = useMemo(() => datos?.dias.find((d) => d.fecha === seleccion) || null, [datos, seleccion]);
  const hoyInfo = useMemo(() => datos?.dias.find((d) => d.fecha === datos.hoy) || null, [datos]);
  const esPasado = (f: string) => Boolean(datos && f < datos.hoy);

  const ejecutar = async (fn: () => Promise<void>) => {
    setGuardando(true);
    setError(null);
    try {
      await fn();
      if (mes) await cargar(mes);
    } catch (e: any) {
      setError(e.message || 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  };

  const celdas = useMemo(() => {
    if (!mes || !datos) return [] as Array<DiaCalendario | null>;
    const inicioSemana = (new Date(Date.UTC(mes.anio, mes.mes - 1, 1)).getUTCDay() + 6) % 7; // lunes = 0
    const arr: Array<DiaCalendario | null> = Array(inicioSemana).fill(null);
    for (const d of datos.dias) arr.push(d);
    return arr;
  }, [mes, datos]);

  const cambiarMes = (delta: number) => {
    if (!mes) return;
    const d = new Date(Date.UTC(mes.anio, mes.mes - 1 + delta, 1));
    setMes({ anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 });
    setSeleccion(null);
  };

  const autorizadosIds = new Set(diaSel?.autorizados.map((a) => a.usuarioId));
  const disponibles = trabajadores.filter((t) => !autorizadosIds.has(t.id));

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <h3 className="text-base font-semibold text-slate-900">Días no laborables</h3>
        <p className="mt-1 text-sm text-slate-600">
          En un día no laborable la aplicación queda <strong>bloqueada</strong> para los trabajadores: no pueden ingresar ni marcar
          asistencia, y cada intento queda anotado en “Alertas de fraude”. Quien ya tiene un turno abierto puede terminarlo. Los
          feriados de Perú vienen precargados como <strong>sugerencia</strong>: verifíquelos con el decreto oficial y use “Habilitar la
          app” si ese día se trabaja.
        </p>
        {hoyInfo && datos && (
          <p className={`mt-3 inline-flex items-center gap-2 border px-3 py-1.5 text-sm font-medium ${hoyInfo.laborable ? 'border-green-300 bg-green-50 text-green-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
            {hoyInfo.laborable ? <CalendarCheck className="h-4 w-4" aria-hidden /> : <CalendarOff className="h-4 w-4" aria-hidden />}
            Hoy ({fechaLarga(datos.hoy)}): {hoyInfo.laborable ? 'la app está habilitada' : `la app está bloqueada${hoyInfo.motivo ? ` · ${hoyInfo.motivo}` : ''}`}
          </p>
        )}
      </section>

      <section className="panel p-4">
        <h4 className="text-sm font-semibold text-slate-900">Días libres fijos de la semana</h4>
        <p className="mt-0.5 text-sm text-slate-600">La app se bloquea todos esos días (por ejemplo, los domingos), salvo que habilite uno en particular.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {SEMANA.map((s) => (
            <label key={s.n} className={`flex cursor-pointer items-center gap-2 border px-3 py-1.5 text-sm ${libres.includes(s.n) ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-slate-300 bg-white text-slate-700'}`}>
              <input
                type="checkbox"
                checked={libres.includes(s.n)}
                onChange={(e) => {
                  marcarSucio(true);
                  setLibres((prev) => (e.target.checked ? [...prev, s.n] : prev.filter((x) => x !== s.n)));
                }}
              />
              {s.largo}
            </label>
          ))}
          <button
            type="button"
            disabled={!libresSucios || guardando}
            onClick={() =>
              ejecutar(async () => {
                await api.setDiasLibres(libres);
                marcarSucio(false);
              })
            }
            className="btn-primary"
          >
            Guardar
          </button>
        </div>
      </section>

      {error && (
        <p role="alert" className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <button type="button" onClick={() => cambiarMes(-1)} className="btn-secondary px-2" aria-label="Mes anterior">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <h4 className="text-base font-semibold capitalize text-slate-900">
              {mes ? `${MESES[mes.mes - 1]} ${mes.anio}` : '…'} {cargando && <span className="text-xs font-normal text-slate-500">cargando…</span>}
            </h4>
            <button type="button" onClick={() => cambiarMes(1)} className="btn-secondary px-2" aria-label="Mes siguiente">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-500">
            {SEMANA.map((s) => (
              <div key={s.n}>{s.corto}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {celdas.map((d, i) =>
              d ? (
                <button
                  key={d.fecha}
                  type="button"
                  onClick={() => {
                    setSeleccion(d.fecha);
                    setMotivo('');
                    setTrabajadorSel('');
                  }}
                  title={d.motivo || undefined}
                  className={`flex min-h-16 flex-col items-start border p-1.5 text-left text-xs transition-shadow hover:shadow ${estiloDia(d)} ${seleccion === d.fecha ? 'ring-2 ring-brand-600' : ''} ${datos && d.fecha === datos.hoy ? 'font-bold' : ''}`}
                >
                  <span className="text-sm">{Number(d.fecha.slice(8))}</span>
                  {d.motivo && !d.laborable && <span className="mt-0.5 line-clamp-2 leading-tight">{d.motivo}</span>}
                  {d.laborable && d.feriado && <span className="mt-0.5 line-clamp-2 leading-tight">{d.feriado} · habilitado</span>}
                  {d.autorizados.length > 0 && <span className="mt-auto font-semibold">{d.autorizados.length} autorizado(s)</span>}
                </button>
              ) : (
                <div key={`v${i}`} />
              )
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
            <span className="flex items-center gap-1"><i className="inline-block h-3 w-3 border border-amber-300 bg-amber-50" /> Bloqueado por regla (feriado o día libre)</span>
            <span className="flex items-center gap-1"><i className="inline-block h-3 w-3 border border-red-300 bg-red-50" /> Bloqueado por el administrador</span>
            <span className="flex items-center gap-1"><i className="inline-block h-3 w-3 border border-green-400 bg-green-50" /> Habilitado por el administrador</span>
          </div>
        </section>

        <section className="panel p-4">
          {!diaSel ? (
            <p className="text-sm text-slate-600">Toque un día del calendario para ver o cambiar lo que pasa ese día.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <h4 className="text-base font-semibold text-slate-900 first-letter:uppercase">{fechaLarga(diaSel.fecha)}</h4>
                <p className={`mt-1 text-sm font-medium ${diaSel.laborable ? 'text-green-800' : 'text-amber-800'}`}>
                  {diaSel.laborable ? 'La app está habilitada' : 'La app está bloqueada'}
                  {diaSel.motivo ? ` · ${diaSel.motivo}` : ''}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {diaSel.origen === 'admin' && 'Decisión del administrador.'}
                  {diaSel.origen === 'semanal' && 'Por día libre fijo de la semana.'}
                  {diaSel.origen === 'feriado' && 'Feriado precargado (sugerido).'}
                  {diaSel.origen === 'normal' && 'Día laborable normal.'}
                </p>
              </div>

              {esPasado(diaSel.fecha) ? (
                <p className="text-sm text-slate-600">Este día ya pasó: no se puede cambiar.</p>
              ) : (
                <>
                  <div>
                    <label htmlFor="cal-motivo" className="field-label">Motivo (opcional)</label>
                    <input id="cal-motivo" className="field" maxLength={120} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: Se trabaja por contrato" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!(diaSel.decision === true) && !diaSel.laborable && (
                      <button type="button" disabled={guardando} className="btn-primary" onClick={() => ejecutar(() => api.setDiaCalendario(diaSel.fecha, true, motivo))}>
                        Habilitar la app este día
                      </button>
                    )}
                    {diaSel.laborable && diaSel.decision !== false && (
                      <button type="button" disabled={guardando} className="btn-secondary" onClick={() => ejecutar(() => api.setDiaCalendario(diaSel.fecha, false, motivo))}>
                        Bloquear la app este día
                      </button>
                    )}
                    {diaSel.decision !== null && (
                      <button type="button" disabled={guardando} className="btn-secondary" onClick={() => ejecutar(() => api.setDiaCalendario(diaSel.fecha, null))}>
                        Quitar mi decisión
                      </button>
                    )}
                  </div>

                  {(!diaSel.laborable || diaSel.autorizados.length > 0) && (
                    <div className="border-t border-slate-200 pt-3">
                      <h5 className="text-sm font-semibold text-slate-900">Trabajadores autorizados este día</h5>
                      <p className="text-xs text-slate-600">Solo ellos podrán usar la app aunque el día esté bloqueado.</p>
                      <ul className="mt-2 space-y-1">
                        {diaSel.autorizados.length === 0 && <li className="text-sm text-slate-500">Ninguno.</li>}
                        {diaSel.autorizados.map((a) => (
                          <li key={a.usuarioId} className="flex items-center justify-between gap-2 border border-slate-200 px-2 py-1.5 text-sm">
                            <span>
                              {a.nombre} <span className="text-slate-500">({a.codigo})</span>
                              {a.motivo && <span className="block text-xs text-slate-500">{a.motivo}</span>}
                            </span>
                            <button type="button" disabled={guardando} aria-label={`Quitar a ${a.nombre}`} className="text-red-700 hover:text-red-900" onClick={() => ejecutar(() => api.quitarAutorizadoDia(diaSel.fecha, a.usuarioId))}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 flex gap-2">
                        <select aria-label="Trabajador a autorizar" className="field py-2" value={trabajadorSel} onChange={(e) => setTrabajadorSel(e.target.value ? Number(e.target.value) : '')}>
                          <option value="">Elegir trabajador…</option>
                          {disponibles.map((t) => (
                            <option key={t.id} value={t.id}>{t.nombre} ({t.codigo_empleado})</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={guardando || trabajadorSel === ''}
                          className="btn-primary whitespace-nowrap"
                          onClick={() => ejecutar(async () => { await api.autorizarTrabajadorDia(diaSel.fecha, Number(trabajadorSel), motivo); setTrabajadorSel(''); })}
                        >
                          Autorizar
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
