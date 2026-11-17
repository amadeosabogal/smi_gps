import React from 'react';
import { CalendarOff } from 'lucide-react';
import { BrandLogo } from './BrandLogo';

interface Props {
  fecha: string | null; // AAAA-MM-DD
  motivo: string | null;
  /** Quien ya inició sesión puede cerrarla; quien venía del ingreso solo vuelve */
  conSesion: boolean;
  comprobando: boolean;
  onComprobar: () => void;
  onSalir: () => void;
}

const fechaLarga = (f: string | null) => {
  if (!f) return '';
  const [y, m, d] = f.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// Pantalla que ve el trabajador cuando hoy es un día no laborable y no está autorizado
export const DiaNoLaborable: React.FC<Props> = ({ fecha, motivo, conSesion, comprobando, onComprobar, onSalir }) => (
  <div className="flex min-h-screen flex-col items-center justify-center bg-slate-100 p-4">
    <div className="w-full max-w-sm border border-slate-300 bg-white p-6 text-center shadow-sm">
      <BrandLogo variant="azul" className="mx-auto mb-5 h-10 w-auto" />
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center bg-amber-100 text-amber-800">
        <CalendarOff className="h-7 w-7" aria-hidden />
      </div>
      <h1 className="text-xl font-semibold text-slate-900">Hoy es un día no laborable</h1>
      {fecha && <p className="mt-1 text-sm text-slate-600 first-letter:uppercase">{fechaLarga(fecha)}</p>}
      {motivo && <p className="mt-2 text-base font-medium text-slate-800">{motivo}</p>}
      <p className="mt-4 text-sm leading-relaxed text-slate-600">
        La aplicación está bloqueada y no se puede registrar asistencia. Si debe trabajar hoy, pida al administrador que lo
        autorice.
      </p>
      {conSesion ? (
        <>
          <button type="button" onClick={onComprobar} disabled={comprobando} className="btn-primary mt-5 w-full">
            {comprobando ? 'Comprobando…' : 'Comprobar de nuevo'}
          </button>
          <button type="button" onClick={onSalir} className="btn-secondary mt-2 w-full">
            Cerrar sesión
          </button>
        </>
      ) : (
        <button type="button" onClick={onSalir} className="btn-primary mt-5 w-full">
          Volver al ingreso
        </button>
      )}
    </div>
  </div>
);
