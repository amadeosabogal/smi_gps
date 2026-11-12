import React, { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

// Aviso de nueva versión de la aplicación.
// Al publicar una actualización, la copia guardada en el celular o en el navegador no cambia sola:
// aquí se avisa y la persona decide cuándo actualizar (así nunca se recarga a mitad de un registro).

const REVISAR_CADA_MS = 30 * 60 * 1000; // buscar versiones nuevas cada 30 minutos con la app abierta

export const UpdatePrompt: React.FC = () => {
  const registro = useRef<ServiceWorkerRegistration | null>(null);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      registro.current = registration ?? null;
    },
  });

  // Buscar versiones nuevas periódicamente y cada vez que se vuelve a la app
  useEffect(() => {
    const buscar = () => registro.current?.update().catch(() => {});
    const id = window.setInterval(buscar, REVISAR_CADA_MS);
    const alVolver = () => {
      if (document.visibilityState === 'visible') buscar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, []);

  if (!needRefresh) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-[70] p-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-3 border border-slate-300 border-l-4 border-l-brand-600 bg-white p-4 shadow-xl sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Hay una nueva versión disponible</p>
          <p className="text-sm text-slate-600">
            Actualice para usar las últimas mejoras. Si está registrando su asistencia, termine primero.
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button type="button" onClick={() => setNeedRefresh(false)} className="btn-secondary btn-sm">
            Más tarde
          </button>
          <button type="button" onClick={() => updateServiceWorker(true)} className="btn-primary btn-sm">
            Actualizar
          </button>
        </div>
      </div>
    </div>
  );
};
