import React, { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { api } from '../services/api';
import type { HorasAviso, RecordatoriosConfig, RecordatoriosRespuesta } from '../types';

// Horas a las que se recuerda a los trabajadores en turno que marquen su almuerzo y su salida.

type Grupo = 'semana' | 'sabado' | 'domingo';
const GRUPOS: { id: Grupo; nombre: string }[] = [
  { id: 'semana', nombre: 'Lunes a viernes' },
  { id: 'sabado', nombre: 'Sábado' },
  { id: 'domingo', nombre: 'Domingo' },
];

export const RecordatoriosPanel: React.FC = () => {
  const [datos, setDatos] = useState<RecordatoriosRespuesta | null>(null);
  const [config, setConfig] = useState<RecordatoriosConfig | null>(null);
  const [guardando, setGuardando] = useState<boolean>(false);
  const [aviso, setAviso] = useState<{ texto: string; error: boolean } | null>(null);

  useEffect(() => {
    api
      .getRecordatorios()
      .then((r) => {
        setDatos(r);
        setConfig(r.config);
      })
      .catch(() => {
        /* servidor sin la función: el apartado no se muestra */
      });
  }, []);

  // Sin las tablas en la base no se muestra nada
  if (!datos?.habilitado || !config) return null;

  const cambiarHora = (grupo: Grupo, campo: keyof HorasAviso, valor: string) => {
    setAviso(null);
    setConfig({ ...config, [grupo]: { ...config[grupo], [campo]: valor || null } });
  };

  const guardar = async () => {
    setGuardando(true);
    setAviso(null);
    try {
      const r = await api.guardarRecordatorios(config);
      setDatos(r);
      setConfig(r.config);
      setAviso({ texto: 'Recordatorios guardados.', error: false });
    } catch (err: any) {
      setAviso({ texto: err.message || 'No se pudo guardar', error: true });
    } finally {
      setGuardando(false);
    }
  };

  const sinCambios = JSON.stringify(config) === JSON.stringify(datos.config);

  return (
    <section className="panel p-4">
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <BellRing className="h-5 w-5 text-brand-600" aria-hidden />
        Recordatorios de marcación
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Llegan al celular de quien está en turno y todavía no ha marcado. Cada aviso se repite una vez a los 15 minutos. Deje una
        hora vacía para no avisar.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="text-left text-sm">
          <thead className="text-xs font-semibold text-slate-500">
            <tr>
              <th className="py-1 pr-6">Días</th>
              {datos.almuerzoHabilitado && <th className="py-1 pr-6">Salida a almorzar</th>}
              <th className="py-1">Salida del trabajo</th>
            </tr>
          </thead>
          <tbody>
            {GRUPOS.map((g) => (
              <tr key={g.id}>
                <th scope="row" className="py-1.5 pr-6 font-medium text-slate-800">
                  {g.nombre}
                </th>
                {datos.almuerzoHabilitado && (
                  <td className="py-1.5 pr-6">
                    <input
                      type="time"
                      className="field w-36"
                      aria-label={`Hora de almuerzo, ${g.nombre}`}
                      value={config[g.id].almuerzo || ''}
                      onChange={(e) => cambiarHora(g.id, 'almuerzo', e.target.value)}
                    />
                  </td>
                )}
                <td className="py-1.5">
                  <input
                    type="time"
                    className="field w-36"
                    aria-label={`Hora de salida, ${g.nombre}`}
                    value={config[g.id].salida || ''}
                    onChange={(e) => cambiarHora(g.id, 'salida', e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {datos.almuerzoHabilitado && (
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={config.finAlmuerzo}
            onChange={(e) => {
              setAviso(null);
              setConfig({ ...config, finAlmuerzo: e.target.checked });
            }}
          />
          <span>
            Avisar cuando se cumplan los {datos.almuerzoMinutos} minutos de almuerzo, para que marque que terminó (cuenta desde que
            cada trabajador lo inició).
          </span>
        </label>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={guardando || sinCambios} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar recordatorios'}
        </button>
        {aviso && <p className={`text-sm ${aviso.error ? 'text-red-800' : 'text-green-800'}`}>{aviso.texto}</p>}
      </div>
    </section>
  );
};
