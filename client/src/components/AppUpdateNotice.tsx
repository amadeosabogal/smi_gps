import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../services/api';
import { nativeTracker } from '../services/nativeTracker';

interface Disponible {
  versionName: string;
  versionCode: number;
  url: string;
  notas: string;
  urgente: boolean;
}

const CLAVE_DESCARTADA = 'smi_update_descartada';

// Aviso dentro de la app Android cuando hay un APK más nuevo publicado en el servidor.
// Si la versión instalada es menor que la mínima exigida ("urgente"), el aviso no se puede cerrar.
export const AppUpdateNotice: React.FC = () => {
  const [nueva, setNueva] = useState<Disponible | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revisar = useCallback(async () => {
    try {
      const [{ android }, instalada] = await Promise.all([api.getAppVersion(), nativeTracker.versionInstalada()]);
      if (!android || android.versionCode <= instalada.code) {
        setNueva(null);
        return;
      }
      const urgente = android.minVersionCode > instalada.code;
      let descartada = 0;
      try {
        descartada = Number(localStorage.getItem(CLAVE_DESCARTADA) || 0);
      } catch {
        /* almacenamiento no disponible */
      }
      if (!urgente && descartada >= android.versionCode) {
        setNueva(null);
        return;
      }
      setNueva({ versionName: android.versionName, versionCode: android.versionCode, url: android.url, notas: android.notas, urgente });
    } catch {
      /* sin conexión: se vuelve a revisar al regresar a la app */
    }
  }, []);

  useEffect(() => {
    revisar();
    const alVolver = () => {
      if (document.visibilityState === 'visible') revisar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [revisar]);

  if (!nueva) return null;

  const descargar = async () => {
    setError(null);
    try {
      await nativeTracker.abrirEnlace(nueva.url);
    } catch (e: any) {
      setError(e?.message || 'No se pudo abrir la descarga');
    }
  };

  const descartar = () => {
    try {
      localStorage.setItem(CLAVE_DESCARTADA, String(nueva.versionCode));
    } catch {
      /* almacenamiento no disponible */
    }
    setNueva(null);
  };

  return (
    <div
      className={`fixed inset-x-0 top-0 z-[60] border-b px-4 py-3 text-sm shadow-md ${
        nueva.urgente ? 'border-red-800 bg-red-700 text-white' : 'border-brand-800 bg-brand-700 text-white'
      }`}
      style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      role="status"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <Download className="h-5 w-5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {nueva.urgente ? 'Debe actualizar la aplicación' : 'Hay una nueva versión de la aplicación'} ({nueva.versionName})
          </p>
          {nueva.notas && <p className="text-xs opacity-90">{nueva.notas}</p>}
          {error && <p className="text-xs font-semibold">{error}</p>}
        </div>
        <button type="button" onClick={descargar} className="flex-shrink-0 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900">
          Descargar
        </button>
        {!nueva.urgente && (
          <button type="button" onClick={descartar} className="flex-shrink-0 px-2 py-1.5 text-xs font-semibold underline">
            Ahora no
          </button>
        )}
      </div>
    </div>
  );
};
