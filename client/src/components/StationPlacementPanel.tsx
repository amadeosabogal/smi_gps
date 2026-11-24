import React from 'react';
import { MapPin, X } from 'lucide-react';

interface Props {
  punto: { lat: number; lng: number } | null;
  codigo: string;
  onCodigo: (v: string) => void;
  nombre: string;
  onNombre: (v: string) => void;
  radio: string;
  onRadio: (v: string) => void;
  color: string;
  onColor: (v: string) => void;
  /** Proyectos disponibles (si no hay ninguno, el selector no se muestra) */
  proyectos?: { id: number; nombre: string }[];
  proyectoId?: string;
  onProyecto?: (v: string) => void;
  /** Aviso si la nueva geocerca se cruza con otra estación (el sistema asigna al trabajador la estación más cercana) */
  aviso: string | null;
  guardando: boolean;
  onGuardar: () => void;
  onCancelar: () => void;
}

// Formulario que aparece sobre el mapa al pulsar "Registrar nueva estación"
export const StationPlacementPanel: React.FC<Props> = ({
  punto,
  codigo,
  onCodigo,
  nombre,
  onNombre,
  radio,
  onRadio,
  color,
  onColor,
  proyectos = [],
  proyectoId = '',
  onProyecto,
  aviso,
  guardando,
  onGuardar,
  onCancelar,
}) => {
  const radioNum = Number(radio);
  const radioValido = Number.isFinite(radioNum) && radioNum >= 5 && radioNum <= 5000;
  const completo = Boolean(punto) && codigo.trim() !== '' && nombre.trim() !== '' && radioValido;

  return (
    <section className="panel border-l-4 border-l-brand-600 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <MapPin className="h-4 w-4 text-brand-700" />
            Registrar nueva estación
          </h3>
          <p className="mt-0.5 text-sm text-slate-600">
            {punto
              ? 'Punto marcado. Ajuste el radio con la barra, arrastre el punto para moverlo o haga clic en otro lugar del mapa (en Google Maps también puede estirar el borde del círculo).'
              : 'Paso 1: haga clic en el mapa en el punto exacto de la estación.'}
          </p>
        </div>
        <button type="button" onClick={onCancelar} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Cancelar">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 ${punto ? '' : 'pointer-events-none opacity-50'}`}>
        <div>
          <label className="field-label">Código (ej. EST-05)</label>
          <input type="text" value={codigo} onChange={(e) => onCodigo(e.target.value)} className="field" />
        </div>
        <div>
          <label className="field-label">Nombre de la estación</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => onNombre(e.target.value)}
            placeholder="ej. Patio de Maniobras Norte"
            className="field"
          />
        </div>

        {proyectos.length > 0 && onProyecto && (
          <div className="sm:col-span-2">
            <label className="field-label">Proyecto</label>
            <select value={proyectoId} onChange={(e) => onProyecto(e.target.value)} className="field">
              <option value="">Sin proyecto</option>
              {proyectos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="sm:col-span-2">
          <label className="field-label">Radio de la geocerca: {radioValido ? `${Math.round(radioNum)} m` : '—'}</label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5}
              max={500}
              step={1}
              value={radioValido ? Math.min(500, radioNum) : 50}
              onChange={(e) => onRadio(e.target.value)}
              className="h-2 flex-1 cursor-pointer accent-brand-600"
            />
            <input
              type="number"
              min={5}
              max={5000}
              value={radio}
              onChange={(e) => onRadio(e.target.value)}
              className="field w-24"
            />
            <input type="color" value={color} onChange={(e) => onColor(e.target.value)} className="field h-9 w-12 p-0.5" title="Color" />
          </div>
          {!radioValido && <p className="mt-1 text-xs text-red-700">El radio debe estar entre 5 y 5000 metros.</p>}
        </div>
      </div>

      {punto && (
        <p className="mt-2 text-xs text-slate-500">
          Coordenadas: <span className="font-mono text-slate-700">{punto.lat.toFixed(6)}, {punto.lng.toFixed(6)}</span>
        </p>
      )}
      {aviso && <p className="mt-2 border-l-4 border-l-amber-600 bg-amber-50 px-3 py-2 text-sm text-amber-900">{aviso}</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancelar} className="btn-secondary">
          Cancelar
        </button>
        <button type="button" onClick={onGuardar} disabled={!completo || guardando} className="btn-primary disabled:opacity-50">
          {guardando ? 'Guardando…' : 'Guardar estación'}
        </button>
      </div>
    </section>
  );
};
