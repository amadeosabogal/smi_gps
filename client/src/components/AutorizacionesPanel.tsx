import React, { useState } from 'react';
import { Check, MapPin, X } from 'lucide-react';
import { api } from '../services/api';
import { AuthImage } from './AuthImage';
import { NOMBRE_MARCACION } from '../services/useAutorizacion';
import type { AutorizacionPanel, EstadoSolicitud } from '../types';

// Pestaña "Autorizaciones": la oficina aprueba o rechaza las marcaciones de quienes no lograron la prueba de vida.

const hora = (f: string) => new Date(f).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fechaHora = (f: string) => new Date(f).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const mayuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const ESTADOS: Record<EstadoSolicitud, { texto: string; clase: string }> = {
  pendiente: { texto: 'Pendiente', clase: 'border-amber-300 bg-amber-50 text-amber-900' },
  aprobada: { texto: 'Aprobada', clase: 'border-green-300 bg-green-50 text-green-800' },
  rechazada: { texto: 'Rechazada', clase: 'border-red-300 bg-red-50 text-red-800' },
  vencida: { texto: 'Venció sin respuesta', clase: 'border-slate-300 bg-slate-50 text-slate-700' },
  anulada: { texto: 'Anulada', clase: 'border-slate-300 bg-slate-50 text-slate-700' },
};

const Solicitud: React.FC<{ s: AutorizacionPanel; onResuelta: () => void }> = ({ s, onResuelta }) => {
  const [enviando, setEnviando] = useState<boolean>(false);
  const [rechazando, setRechazando] = useState<boolean>(false);
  const [motivo, setMotivo] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const que = NOMBRE_MARCACION[s.tipo];

  const ejecutar = async (accion: () => Promise<unknown>) => {
    setEnviando(true);
    setError(null);
    try {
      await accion();
    } catch (err: any) {
      setError(err.message || 'No se pudo completar la acción');
    } finally {
      setEnviando(false);
      onResuelta();
    }
  };
  const aprobar = () => {
    if (!window.confirm(`¿Aprobar la ${que} de ${s.nombre_usuario}?\n\nConfirme antes que la persona de la foto es la registrada.\nHora que se registrará: ${hora(s.creada_en)}`)) return;
    ejecutar(() => api.aprobarAutorizacion(s.id));
  };

  return (
    <article className="panel border-t-4 border-t-amber-600 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-base font-semibold text-slate-900">{s.nombre_usuario}</h4>
          <p className="text-sm text-slate-600">
            {s.codigo_empleado}
            {s.cargo ? ` · ${s.cargo}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-slate-900">{mayuscula(que)}</p>
          <p className="text-sm text-slate-600">
            Pedida a las {hora(s.creada_en)} · vence en {Math.max(1, Math.ceil(s.segundos_restantes / 60))} min
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <figure className="flex flex-col items-center border border-slate-200 p-2">
          <figcaption className="mb-1 text-xs font-medium text-slate-600">Rostro registrado</figcaption>
          <AuthImage eager path={`/photos/user/${s.usuario_id}/reference?v=s${s.id}`} alt="Rostro registrado" className="h-56 w-full object-contain" />
        </figure>
        <figure className="flex flex-col items-center border border-slate-200 p-2">
          <figcaption className="mb-1 text-xs font-medium text-slate-600">Foto de la solicitud</figcaption>
          <AuthImage eager path={`/photos/authorization/${s.id}`} alt="Foto de la solicitud" className="h-56 w-full object-contain" />
        </figure>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <span className="tag border-green-300 bg-green-50 text-green-800">Rostro: {Math.round(s.similitud)}% de similitud</span>
        <span className="tag">
          {s.fallos} fallo{s.fallos === 1 ? '' : 's'} de la prueba en 15 min
        </span>
        {s.sin_verificacion && <span className="tag border-amber-300 bg-amber-50 text-amber-900">La verificación no cargó en el celular</span>}
        {s.latitud && s.longitud ? (
          <a
            href={`https://www.google.com/maps?q=${s.latitud},${s.longitud}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 hover:underline"
          >
            <MapPin className="h-4 w-4" />
            {s.estacion_nombre || 'Fuera de estación'}
            {s.precision ? ` (±${Math.round(s.precision)} m)` : ''}
          </a>
        ) : (
          <span className="text-slate-500">Sin ubicación en la solicitud</span>
        )}
      </div>

      {rechazando ? (
        <div className="mt-3 space-y-2">
          <label className="field-label" htmlFor={`motivo-${s.id}`}>
            Motivo del rechazo (lo verá el trabajador)
          </label>
          <input id={`motivo-${s.id}`} className="field" maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setRechazando(false)} disabled={enviando}>
              Volver
            </button>
            <button
              type="button"
              className="btn-danger flex-1"
              disabled={enviando || motivo.trim().length < 3}
              onClick={() => ejecutar(() => api.rechazarAutorizacion(s.id, motivo.trim()))}
            >
              Confirmar rechazo
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-primary flex-1" disabled={enviando} onClick={aprobar}>
            <Check className="h-4 w-4" />
            Aprobar
          </button>
          <button type="button" className="btn-secondary flex-1" disabled={enviando} onClick={() => setRechazando(true)}>
            <X className="h-4 w-4" />
            Rechazar
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-800">{error}</p>}
    </article>
  );
};

interface Props {
  pendientes: AutorizacionPanel[];
  resueltas: AutorizacionPanel[];
  onResuelta: () => void;
}

export const AutorizacionesPanel: React.FC<Props> = ({ pendientes, resueltas, onResuelta }) => (
  <div className="space-y-5">
    <p className="text-sm text-slate-600">
      Marcaciones de trabajadores que no lograron la prueba de vida. Antes de aprobar, compare las dos fotos y confirme que es la
      persona en vivo, no una foto o una pantalla. Se registra la hora en que se pidió; cada solicitud espera 30 minutos.
    </p>

    {pendientes.length === 0 ? (
      <div className="panel p-8 text-center text-sm text-slate-600">No hay solicitudes pendientes.</div>
    ) : (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {pendientes.map((s) => (
          <Solicitud key={s.id} s={s} onResuelta={onResuelta} />
        ))}
      </div>
    )}

    {resueltas.length > 0 && (
      <div className="panel overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-600">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-4 py-3">Pedida</th>
              <th className="px-4 py-3">Trabajador</th>
              <th className="px-4 py-3">Marcación</th>
              <th className="px-4 py-3">Resultado</th>
              <th className="px-4 py-3">Resuelta por</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {resueltas.map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap px-4 py-3 font-mono">{fechaHora(s.creada_en)}</td>
                <td className="px-4 py-3 font-semibold text-slate-900">{s.nombre_usuario}</td>
                <td className="px-4 py-3">{mayuscula(NOMBRE_MARCACION[s.tipo])}</td>
                <td className="px-4 py-3">
                  <span className={`tag ${ESTADOS[s.estado].clase}`}>{ESTADOS[s.estado].texto}</span>
                  {s.motivo_rechazo && <p className="mt-1">{s.motivo_rechazo}</p>}
                </td>
                <td className="px-4 py-3">
                  {s.resuelta_por_nombre || '—'}
                  {s.resuelta_en && <p className="text-slate-500">{fechaHora(s.resuelta_en)}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);
