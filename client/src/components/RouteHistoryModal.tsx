import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Circle, Polyline, CircleMarker, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Pause, Play, RefreshCw, X } from 'lucide-react';
import { api } from '../services/api';
import { AuthImage } from './AuthImage';
import { SIN_SENAL_SEG } from '../services/senal';
import type { EstacionTrabajo, RecorridoTurno } from '../types';

interface Props {
  asistenciaId: number;
  workstations: EstacionTrabajo[];
  onClose: () => void;
}

const GAP_SEGUNDOS = SIN_SENAL_SEG; // más tiempo sin ningún punto = hueco de señal (igual que el aviso "Sin señal GPS")
const BATERIA_MAX_SEGUNDOS = 360; // intervalos más largos no cuentan para el consumo de batería
const COLOR_DENTRO = '#1f7a4d';
const COLOR_FUERA = '#b45f06';
const COLOR_HUECO = '#64748b';
const COLOR_ALMUERZO = '#0e7490';

const hora = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const duracion = (seg: number) => {
  const s = Math.max(0, Math.round(seg));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${s} s`;
};

const metros = (a: [number, number], b: [number, number]) => {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 6371e3 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

// Ajusta el mapa para que se vea todo el recorrido cuando llegan los datos
const AjustarVista: React.FC<{ puntos: [number, number][]; clave: number }> = ({ puntos, clave }) => {
  const map = useMap();
  useEffect(() => {
    if (puntos.length === 0) return;
    map.fitBounds(L.latLngBounds(puntos), { padding: [30, 30], maxZoom: 18 });
    // solo al abrir (clave = id del turno), no en cada actualización automática
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, map]);
  return null;
};

// Sigue al marcador durante la reproducción
const Seguir: React.FC<{ punto: [number, number] | null; activo: boolean }> = ({ punto, activo }) => {
  const map = useMap();
  useEffect(() => {
    if (activo && punto && !map.getBounds().contains(punto)) map.panTo(punto, { animate: true });
  }, [punto, activo, map]);
  return null;
};

// Curva de batería del turno: línea del porcentaje, franjas verdes mientras estuvo en el cargador y marca de la posición actual
const CurvaBateria: React.FC<{
  pts: { t: number; bateria?: number | null; cargando?: boolean | null }[];
  actual: number;
}> = ({ pts, actual }) => {
  const datos = pts.filter((p) => p.bateria !== null && p.bateria !== undefined);
  if (datos.length < 2) return null;
  const W = 300;
  const H = 90;
  const t0 = datos[0].t;
  const t1 = datos[datos.length - 1].t;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * W);
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const linea = datos.map((p) => `${x(p.t).toFixed(1)},${y(p.bateria as number).toFixed(1)}`).join(' ');
  // franjas de carga
  const franjas: { x1: number; x2: number }[] = [];
  let ini: number | null = null;
  datos.forEach((p, i) => {
    if (p.cargando && ini === null) ini = p.t;
    if ((!p.cargando || i === datos.length - 1) && ini !== null) {
      franjas.push({ x1: x(ini), x2: x(p.t) });
      ini = null;
    }
  });
  const xa = x(Math.max(t0, Math.min(t1, actual)));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full border border-slate-200 bg-white" preserveAspectRatio="none" role="img" aria-label="Curva de batería del turno">
      {[25, 50, 75].map((v) => (
        <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="#e2e8f0" strokeWidth={0.6} />
      ))}
      {franjas.map((f, i) => (
        <rect key={i} x={f.x1} y={0} width={Math.max(1.5, f.x2 - f.x1)} height={H} fill="#1f7a4d" opacity={0.18} />
      ))}
      <polyline points={linea} fill="none" stroke="#1c42ba" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <line x1={xa} x2={xa} y1={0} y2={H} stroke="#b45f06" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

export const RouteHistoryModal: React.FC<Props> = ({ asistenciaId, workstations, onClose }) => {
  const [data, setData] = useState<RecorridoTurno | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState<boolean>(true);
  const [idx, setIdx] = useState<number>(0);
  const [reproduciendo, setReproduciendo] = useState<boolean>(false);
  const [velocidad, setVelocidad] = useState<number>(4); // puntos por avance (cada 200 ms)
  const siguiendoFinal = useRef<boolean>(true); // si el usuario no movió el control, al actualizar se queda en el último punto

  const cargar = useCallback(async () => {
    try {
      const r = await api.getRoute(asistenciaId);
      setData(r);
      setError(null);
      if (siguiendoFinal.current) setIdx(Math.max(0, r.puntos.length - 1));
    } catch (e: any) {
      setError(e?.message || 'No se pudo cargar el recorrido');
    } finally {
      setCargando(false);
    }
  }, [asistenciaId]);

  useEffect(() => {
    setCargando(true);
    siguiendoFinal.current = true;
    cargar();
  }, [cargar]);

  // Un turno todavía activo se actualiza solo cada 15 s (llega un punto nuevo en ese intervalo)
  const activo = data?.asistencia.estado === 'activo';
  useEffect(() => {
    if (!activo) return;
    const t = setInterval(cargar, 15_000);
    return () => clearInterval(t);
  }, [activo, cargar]);

  // Reproducción del recorrido
  const total = data?.puntos.length ?? 0;
  useEffect(() => {
    if (!reproduciendo) return;
    const t = setInterval(() => {
      setIdx((i) => {
        const nuevo = i + velocidad;
        if (nuevo >= total - 1) {
          setReproduciendo(false);
          return Math.max(0, total - 1);
        }
        return nuevo;
      });
    }, 200);
    return () => clearInterval(t);
  }, [reproduciendo, velocidad, total]);

  // Cálculos del recorrido
  const info = useMemo(() => {
    if (!data || data.puntos.length === 0) return null;
    // Durante el almuerzo el GPS sigue registrando: esos puntos se dibujan en otro color
    const intervalos = (data.almuerzos ?? []).map((a) => ({ ini: Date.parse(a.inicio_en), fin: a.fin_en ? Date.parse(a.fin_en) : Infinity }));
    const pts = data.puntos.map((p) => {
      const t = Date.parse(p.fecha);
      return {
        ...p,
        t,
        ll: [p.lat, p.lng] as [number, number],
        dentro: p.estacionId !== null,
        alm: intervalos.some((i) => t >= i.ini && t <= i.fin),
      };
    });

    let distancia = 0;
    let segFuera = 0;
    let segDentro = 0;
    let segAlmuerzo = 0;
    const huecos: { desde: number; hasta: number; seg: number; i: number }[] = [];
    // Tramos de color: se agrupan los puntos seguidos que están dentro/fuera de una estación; los huecos van aparte (discontinuos)
    const tramos: { positions: [number, number][]; tipo: 'dentro' | 'fuera' | 'almuerzo' }[] = [];
    const lineasHueco: [number, number][][] = [];
    type Tipo = 'dentro' | 'fuera' | 'almuerzo';
    type Tramo = { positions: [number, number][]; tipo: Tipo };
    const tipoDe = (p: { dentro: boolean; alm: boolean }): Tipo => (p.alm ? 'almuerzo' : p.dentro ? 'dentro' : 'fuera');
    let actual: Tramo = { positions: [pts[0].ll], tipo: tipoDe(pts[0]) };

    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[i - 1];
      const dt = (p.t - prev.t) / 1000;
      distancia += metros(prev.ll, p.ll);
      if (dt > GAP_SEGUNDOS) {
        // Hueco de señal: el tramo termina en el último punto recibido y el siguiente empieza en el primero tras el corte
        huecos.push({ desde: prev.t, hasta: p.t, seg: dt, i });
        lineasHueco.push([prev.ll, p.ll]);
        tramos.push(actual);
        actual = { positions: [p.ll], tipo: tipoDe(p) };
        continue;
      }
      if (prev.alm) segAlmuerzo += dt;
      else if (prev.dentro) segDentro += dt;
      else segFuera += dt;
      actual.positions.push(p.ll);
      if (tipoDe(p) !== actual.tipo) {
        // Cambio dentro/fuera de zona o de almuerzo: el punto de cambio cierra el tramo anterior y abre el siguiente (sin dejar espacio)
        tramos.push(actual);
        actual = { positions: [p.ll], tipo: tipoDe(p) };
      }
    }
    tramos.push(actual);

    const sinSenal = huecos.reduce((a, h) => a + h.seg, 0);

    // Batería: consumo medio SIN contar los tramos con el cargador conectado ni los huecos de señal
    const conBat = pts.filter((p) => p.bateria !== null && p.bateria !== undefined);
    let bajada = 0;
    let segSinCarga = 0;
    let segCargando = 0;
    for (let i = 1; i < conBat.length; i++) {
      const a = conBat[i - 1];
      const b = conBat[i];
      const dt = (b.t - a.t) / 1000;
      if (dt > BATERIA_MAX_SEGUNDOS) continue;
      if (a.cargando || b.cargando) {
        segCargando += dt;
      } else {
        segSinCarga += dt;
        const d = (a.bateria as number) - (b.bateria as number);
        if (d > 0) bajada += d;
      }
    }
    const bateria = {
      hay: conBat.length >= 2,
      inicio: conBat.length ? (conBat[0].bateria as number) : null,
      fin: conBat.length ? (conBat[conBat.length - 1].bateria as number) : null,
      // con menos de 30 min sin cargador el dato no es fiable (la batería baja de 1 en 1 %)
      porHora: segSinCarga >= 1800 ? bajada / (segSinCarga / 3600) : null,
      minCargando: segCargando / 60,
    };
    return { pts, distancia, segFuera, segDentro, segAlmuerzo, huecos, sinSenal, tramos, lineasHueco, bateria };
  }, [data]);

  const nombreEstacion = (id: number | null) =>
    id === null ? 'Fuera de zona' : workstations.find((w) => w.id === id)?.nombre || `Estación ${id}`;

  const cur = info ? info.pts[Math.min(idx, info.pts.length - 1)] : null;
  const a = data?.asistencia;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-2 sm:p-4">
      <div className="panel my-2 w-full max-w-6xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Recorrido del turno{a ? ` · ${a.nombre_usuario}` : ''}
            </h2>
            {a && (
              <p className="text-sm text-slate-600">
                {a.codigo_empleado} · Ingresó {new Date(a.hora_ingreso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                {a.hora_salida
                  ? ` · Salió ${new Date(a.hora_salida).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`
                  : ' · Turno en curso (se actualiza solo)'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setCargando(true); cargar(); }} className="btn-secondary btn-sm" title="Actualizar">
              <RefreshCw className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Cerrar">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {error && <p className="p-4 text-sm text-red-800">{error}</p>}
        {cargando && !data && <p className="p-8 text-center text-sm text-slate-500">Cargando recorrido…</p>}

        {data && !info && (
          <p className="p-8 text-center text-sm text-slate-600">
            No hay puntos GPS guardados para este turno. Puede ocurrir si el trabajador no envió ubicación durante el turno, o si
            ya se borraron por la retención de datos.
          </p>
        )}

        {data && info && cur && (
          <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="relative h-[480px] w-full overflow-hidden border border-slate-300">
                <MapContainer center={info.pts[0].ll} zoom={16} scrollWheelZoom preferCanvas className="h-full w-full">
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <AjustarVista puntos={info.pts.map((p) => p.ll)} clave={asistenciaId} />
                  <Seguir punto={cur.ll} activo={reproduciendo} />

                  {workstations.map((w) => (
                    <Circle
                      key={w.id}
                      center={[w.latitud, w.longitud]}
                      radius={w.radio_metros}
                      pathOptions={{ color: w.color || '#3B82F6', fillColor: w.color || '#3B82F6', fillOpacity: 0.1, weight: 1.5, dashArray: '4, 4' }}
                    />
                  ))}

                  {info.lineasHueco.map((l, i) => (
                    <Polyline key={`h${i}`} positions={l} pathOptions={{ color: COLOR_HUECO, weight: 3, dashArray: '2, 8', opacity: 0.9 }} />
                  ))}
                  {info.tramos.map((t, i) => (
                    <Polyline
                      key={`t${i}`}
                      positions={t.positions}
                      pathOptions={{ color: t.tipo === 'almuerzo' ? COLOR_ALMUERZO : t.tipo === 'dentro' ? COLOR_DENTRO : COLOR_FUERA, weight: 4, opacity: 0.9 }}
                    />
                  ))}

                  {/* Puntos individuales (si son demasiados se omiten para no saturar el mapa) */}
                  {info.pts.length <= 1500 &&
                    info.pts.map((p, i) => (
                      <CircleMarker
                        key={i}
                        center={p.ll}
                        radius={2.5}
                        pathOptions={{ color: '#ffffff', weight: 0.5, fillColor: p.alm ? COLOR_ALMUERZO : p.dentro ? COLOR_DENTRO : COLOR_FUERA, fillOpacity: 1 }}
                        eventHandlers={{ click: () => { siguiendoFinal.current = false; setReproduciendo(false); setIdx(i); } }}
                      />
                    ))}

                  <Marker
                    position={info.pts[0].ll}
                    icon={L.divIcon({
                      html: '<div style="background:#1c42ba;color:#fff;font:700 11px Archivo,sans-serif;padding:2px 6px;white-space:nowrap;transform:translate(-50%,-130%);box-shadow:0 1px 3px rgba(15,23,42,.4)">Inicio</div>',
                      className: 'ruta-etiqueta',
                      iconSize: [0, 0],
                    })}
                  />
                  <Marker
                    position={cur.ll}
                    icon={L.divIcon({
                      html: '<div style="width:18px;height:18px;background:#1c42ba;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 2px #1c42ba,0 1px 4px rgba(15,23,42,.5)"></div>',
                      className: 'ruta-actual',
                      iconSize: [18, 18],
                      iconAnchor: [9, 9],
                    })}
                  />
                </MapContainer>
              </div>

              {/* Reproducción */}
              <div className="mt-3 flex flex-wrap items-center gap-3 border border-slate-200 bg-slate-50 p-3">
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => {
                    siguiendoFinal.current = false;
                    if (!reproduciendo && idx >= total - 1) setIdx(0);
                    setReproduciendo((v) => !v);
                  }}
                >
                  {reproduciendo ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {reproduciendo ? 'Pausar' : 'Reproducir'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, total - 1)}
                  value={Math.min(idx, total - 1)}
                  onChange={(e) => {
                    siguiendoFinal.current = false;
                    setReproduciendo(false);
                    setIdx(Number(e.target.value));
                  }}
                  className="h-2 min-w-[160px] flex-1 cursor-pointer accent-brand-600"
                />
                <select value={velocidad} onChange={(e) => setVelocidad(Number(e.target.value))} className="field w-auto py-1 text-xs">
                  <option value={1}>Lento</option>
                  <option value={4}>Normal</option>
                  <option value={16}>Rápido</option>
                </select>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                <span className="font-semibold tabular-nums">{hora(cur.t)}</span> · punto {Math.min(idx, total - 1) + 1} de {total} ·{' '}
                <span className={cur.dentro ? 'font-semibold text-green-800' : 'font-semibold text-amber-800'}>{nombreEstacion(cur.estacionId)}</span>
                {cur.precision != null ? ` · ±${Math.round(cur.precision)} m` : ''}
                {cur.alm ? ' · en almuerzo' : ''}
                {cur.bateria != null ? ` · batería ${cur.bateria} %${cur.cargando ? ' (cargando)' : ''}` : ''}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                <span><span className="mr-1 inline-block h-2 w-4 align-middle" style={{ background: COLOR_DENTRO }} />Dentro de una estación</span>
                <span><span className="mr-1 inline-block h-2 w-4 align-middle" style={{ background: COLOR_FUERA }} />Fuera de zona</span>
                {(data.almuerzos?.length ?? 0) > 0 && (
                  <span><span className="mr-1 inline-block h-2 w-4 align-middle" style={{ background: COLOR_ALMUERZO }} />En almuerzo</span>
                )}
                <span><span className="mr-1 inline-block h-0 w-4 border-t-2 border-dotted align-middle" style={{ borderColor: COLOR_HUECO }} />Sin señal ({'>'} {GAP_SEGUNDOS} s)</span>
              </p>
            </div>

            {/* Resumen del recorrido */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                {[
                  ['Puntos GPS', String(total)],
                  ['Distancia recorrida', info.distancia >= 1000 ? `${(info.distancia / 1000).toFixed(2)} km` : `${Math.round(info.distancia)} m`],
                  ['Dentro de estación', duracion(info.segDentro)],
                  ['Fuera de zona', duracion(info.segFuera)],
                  ...((data.almuerzos?.length ?? 0) > 0 ? [['En almuerzo', duracion(info.segAlmuerzo)]] : []),
                  ['Sin señal', duracion(info.sinSenal)],
                  ['Huecos de señal', String(info.huecos.length)],
                ].map(([k, v]) => (
                  <div key={k} className="border border-slate-200 bg-white p-2.5">
                    <p className="text-xs text-slate-500">{k}</p>
                    <p className="mt-0.5 font-semibold tabular-nums text-slate-900">{v}</p>
                  </div>
                ))}
              </div>

              {(data.almuerzos?.length ?? 0) > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Almuerzo</h3>
                  <p className="text-xs text-slate-500">El GPS siguió registrándose durante el almuerzo (tramo turquesa en el mapa).</p>
                  {(data.almuerzos ?? []).map((al) => {
                    const hm = (d: string) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const min = al.fin_en ? Math.round((Date.parse(al.fin_en) - Date.parse(al.inicio_en)) / 60000) : null;
                    const permitido = data.almuerzoMinutos ?? 60;
                    return (
                      <div key={al.id} className="mt-1.5 border border-slate-200 bg-white p-2.5 text-sm">
                        <p className="text-slate-800">
                          {hm(al.inicio_en)} → {al.fin_en ? hm(al.fin_en) : 'en curso'}
                          {min !== null && (
                            <>
                              {' '}
                              · <strong className={min > permitido ? 'text-red-700' : ''}>{min} min</strong> de {permitido}
                              {min > permitido ? ` (se pasó ${min - permitido} min)` : ''}
                            </>
                          )}
                        </p>
                        {al.cierre && al.cierre !== 'trabajador' && (
                          <p className="text-xs text-slate-500">
                            Cerrado automáticamente por {al.cierre === 'administrador' ? 'una salida forzada del administrador' : 'la salida del turno'}.
                          </p>
                        )}
                        <div className="mt-1.5 flex gap-2">
                          {al.foto_inicio === 1 && (
                            <figure className="text-center">
                              <AuthImage path={`/photos/lunch/${al.id}/in?v=${Date.parse(al.inicio_en)}`} alt="Inicio del almuerzo" className="h-16 w-20 border border-slate-200 object-cover" />
                              <figcaption className="text-[10px] text-slate-500">Inicio</figcaption>
                            </figure>
                          )}
                          {al.foto_fin === 1 && (
                            <figure className="text-center">
                              <AuthImage path={`/photos/lunch/${al.id}/out?v=${Date.parse(al.inicio_en)}-${al.fin_en ? Date.parse(al.fin_en) : ''}`} alt="Fin del almuerzo" className="h-16 w-20 border border-slate-200 object-cover" />
                              <figcaption className="text-[10px] text-slate-500">Fin</figcaption>
                            </figure>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <h3 className="text-sm font-semibold text-slate-900">Batería del teléfono</h3>
                {info.bateria.hay ? (
                  <>
                    <div className="mt-1">
                      <CurvaBateria pts={info.pts} actual={cur.t} />
                    </div>
                    <p className="mt-1 text-sm text-slate-700">
                      De <strong className="tabular-nums">{info.bateria.inicio} %</strong> a{' '}
                      <strong className="tabular-nums">{info.bateria.fin} %</strong>
                      {info.bateria.porHora !== null && (
                        <>
                          {' '}
                          · consumo medio ≈ <strong className="tabular-nums">{info.bateria.porHora.toFixed(1)} % por hora</strong> sin cargador
                        </>
                      )}
                      {info.bateria.minCargando >= 1 && <> · cargando {duracion(info.bateria.minCargando * 60)}</>}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">La franja verde marca cuándo estuvo conectado al cargador.</p>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-slate-600">
                    Sin datos de batería en este turno (solo los envía la app Android 1.0.2 o posterior).
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-900">Huecos de señal</h3>
                {info.huecos.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-600">Sin huecos: se recibió ubicación de forma continua.</p>
                ) : (
                  <ul className="mt-1 max-h-48 divide-y divide-slate-100 overflow-y-auto border border-slate-200 bg-white text-sm">
                    {info.huecos
                      .slice()
                      .sort((x, y) => y.seg - x.seg)
                      .slice(0, 30)
                      .map((h) => (
                        <li key={h.i}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-slate-50"
                            onClick={() => { siguiendoFinal.current = false; setReproduciendo(false); setIdx(h.i - 1); }}
                          >
                            <span className="tabular-nums text-slate-700">{hora(h.desde)} → {hora(h.hasta)}</span>
                            <span className="font-semibold text-red-800">{duracion(h.seg)}</span>
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  Un hueco es un tramo de más de {GAP_SEGUNDOS} segundos sin recibir ubicación del celular (sin internet, GPS apagado,
                  app cerrada o celular apagado). Toque uno para verlo en el mapa.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
