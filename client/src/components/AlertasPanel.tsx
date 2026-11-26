import React, { useState } from 'react';
import { ChevronDown, ChevronRight, MapPin, ShieldAlert, ShieldCheck } from 'lucide-react';
import { AuthImage } from './AuthImage';
import type { AuditoriaFraudeFacial, GrupoAlertas } from '../types';

// Pestaña "Alertas de fraude": una fila por trabajador, día y tipo de alerta. Cada fila se abre para ver sus intentos.

// Nombre legible de los tipos de evento de la auditoría
const etiquetaEvento = (tipo: string) =>
  ({
    SUPLANTACION_ROSTRO: 'Suplantación de rostro',
    FALLA_PRUEBA_VIDA: 'Falla en la prueba de vida',
    INTENTO_DIA_NO_LABORABLE: 'Intento en día no laborable',
    GPS_APAGADO: 'Apagó la ubicación (GPS)',
    GPS_REACTIVADO: 'Reactivó la ubicación (GPS)',
    SIN_SENAL_GPS: 'Sin señal GPS en turno',
  } as Record<string, string>)[tipo] || tipo.charAt(0) + tipo.slice(1).toLowerCase().replace(/_/g, ' ');

// Solo estos eventos comparan rostros: en los demás no hay "similitud" que mostrar
const EVENTOS_CON_SIMILITUD = ['SUPLANTACION_ROSTRO'];

const MOTIVOS: Record<string, string> = {
  inestable: 'sin quedarse quieto de frente',
  tiempo: 'gesto fuera de tiempo',
  sin_rostro: 'rostro fuera de vista',
  continuidad: 'no se confirmó la misma persona',
};

const hora = (f: string) => new Date(f).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fechaHora = (f: string) => new Date(f).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });

const resumen = (g: GrupoAlertas) => {
  const motivos = Object.entries(g.motivos).sort((a, b) => b[1] - a[1]);
  if (motivos.length) return motivos.map(([m, n]) => `${n} ${MOTIVOS[m] || m}`).join(' · ');
  return g.alertas[0]?.notas || (g.tipo_evento === 'SUPLANTACION_ROSTRO' ? 'Rostro no coincide con el registrado' : '—');
};

export const rutaFotoAlerta = (a: AuditoriaFraudeFacial) => `/photos/fraud/${a.id}?v=${Date.parse(a.fecha_intento)}`;

// La nota puede traer después de "|" los datos técnicos del intento: se muestran aparte, en pequeño
const Nota: React.FC<{ texto: string }> = ({ texto }) => {
  const [principal, ...datos] = texto.split(' | ');
  return (
    <span className="min-w-0 flex-1 break-words">
      {principal}
      {datos.length > 0 && <span className="mt-0.5 block text-[11px] text-slate-400">{datos.join(' | ')}</span>}
    </span>
  );
};

const Foto: React.FC<{ alerta?: AuditoriaFraudeFacial; onVer: (a: AuditoriaFraudeFacial) => void }> = ({ alerta, onVer }) =>
  alerta ? (
    <button
      type="button"
      onClick={() => onVer(alerta)}
      className="inline-flex border border-slate-300 bg-white p-0.5 transition-colors hover:border-brand-600"
    >
      <AuthImage path={rutaFotoAlerta(alerta)} alt="Foto del intento" className="h-10 w-10 object-cover" />
    </button>
  ) : (
    <span className="text-xs italic text-slate-400">Sin foto</span>
  );

const Similitud: React.FC<{ alerta: AuditoriaFraudeFacial }> = ({ alerta }) =>
  EVENTOS_CON_SIMILITUD.includes(alerta.tipo_evento) ? (
    <span className="font-mono text-xs font-semibold text-red-700">{Math.round(alerta.similitud_obtenida ?? 0)}% de similitud</span>
  ) : null;

const Ubicacion: React.FC<{ alerta: AuditoriaFraudeFacial }> = ({ alerta }) =>
  alerta.latitud && alerta.longitud ? (
    <a
      href={`https://www.google.com/maps?q=${alerta.latitud},${alerta.longitud}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
    >
      <MapPin className="h-3 w-3" />
      Ver ubicación
    </a>
  ) : null;

interface Props {
  grupos: GrupoAlertas[];
  busqueda: string;
  onVerFoto: (a: AuditoriaFraudeFacial) => void;
}

export const AlertasPanel: React.FC<Props> = ({ grupos, busqueda, onVerFoto }) => {
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const alternar = (clave: string) =>
    setAbiertos((prev) => {
      const s = new Set(prev);
      if (!s.delete(clave)) s.add(clave);
      return s;
    });

  const q = busqueda.toLowerCase();
  const visibles = grupos.filter((g) =>
    [g.nombre_usuario, g.codigo_empleado, g.tipo_evento, etiquetaEvento(g.tipo_evento)].some((t) => (t || '').toLowerCase().includes(q))
  );
  const intentos = grupos.reduce((n, g) => n + g.total, 0);

  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center justify-between gap-3 border-l-4 border-l-red-700 p-4">
        <div className="flex items-center gap-3">
          <ShieldAlert className="h-6 w-6 flex-shrink-0 text-red-700" />
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Alertas de fraude y seguridad</h3>
            <p className="text-sm text-slate-600">
              Una fila por trabajador, día y tipo: rostros que no coinciden, pruebas de vida fallidas y avisos de ubicación.
            </p>
          </div>
        </div>
        <span className="tag tabular-nums">
          {grupos.length} fila{grupos.length === 1 ? '' : 's'} · {intentos} alerta{intentos === 1 ? '' : 's'}
        </span>
      </div>

      {visibles.length === 0 ? (
        <div className="panel p-10 text-center">
          <ShieldCheck className="mx-auto mb-2 h-8 w-8 text-green-700" />
          <h4 className="text-sm font-semibold text-slate-800">{grupos.length ? 'Sin resultados para la búsqueda' : 'Sin alertas'}</h4>
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500">
              <tr>
                <th className="px-4 py-3">Último</th>
                <th className="px-4 py-3">Trabajador</th>
                <th className="px-4 py-3">Tipo de evento</th>
                <th className="px-4 py-3 text-center">Veces</th>
                <th className="px-4 py-3 text-center">Última foto</th>
                <th className="px-4 py-3">Resumen</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibles.map((g) => {
                const abierto = abiertos.has(g.clave);
                return (
                  <React.Fragment key={g.clave}>
                    <tr className={abierto ? 'bg-slate-50' : 'hover:bg-slate-50'}>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-700">{fechaHora(g.ultima)}</td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{g.nombre_usuario || `Usuario #${g.usuario_id}`}</div>
                        <span className="font-mono text-xs text-slate-500">{g.codigo_empleado}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="tag border-red-300 bg-red-50 text-red-800">{etiquetaEvento(g.tipo_evento)}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-base font-semibold tabular-nums text-slate-900">{g.total}</span>
                        {g.total > 1 && (
                          <p className="whitespace-nowrap text-xs text-slate-500">
                            {hora(g.primera)} a {hora(g.ultima)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Foto alerta={g.alertas.find((a) => a.tiene_foto_intento)} onVer={onVerFoto} />
                      </td>
                      <td className="max-w-md px-4 py-3">
                        {resumen(g)}
                        {g.total === 1 && g.alertas[0] && (
                          <div>
                            <Similitud alerta={g.alertas[0]} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" onClick={() => alternar(g.clave)} aria-expanded={abierto} className="btn-secondary btn-sm whitespace-nowrap">
                          {abierto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {abierto ? 'Ocultar' : g.total > 1 ? 'Ver intentos' : 'Ver detalle'}
                        </button>
                      </td>
                    </tr>
                    {abierto && (
                      <tr>
                        <td colSpan={7} className="bg-slate-50 px-4 pb-4">
                          <ul className="divide-y divide-slate-200 border border-slate-200 bg-white">
                            {g.alertas.map((a) => (
                              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                                <span className="whitespace-nowrap font-mono text-slate-700">{fechaHora(a.fecha_intento)}</span>
                                {a.tiene_foto_intento ? <Foto alerta={a} onVer={onVerFoto} /> : null}
                                <Nota texto={a.notas || 'Rostro no coincide con el registrado'} />
                                <Similitud alerta={a} />
                                <Ubicacion alerta={a} />
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
