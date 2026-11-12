import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { enablePush, getPushState, type PushState } from '../services/push';

// Panel del trabajador para activar las alertas del supervisor en su celular.
export const PushAlertCard: React.FC = () => {
  const [state, setState] = useState<PushState>('cargando');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await enablePush());
    } catch (err: any) {
      setError(err.message || 'No se pudo activar. Intente de nuevo.');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  // Mientras carga o si el servidor no las ofrece, no se muestra nada
  if (state === 'cargando' || state === 'no-disponible') return null;

  if (state === 'activo') {
    return (
      <section className="panel flex items-start gap-3 border-l-4 border-l-green-700 p-4">
        <BellRing className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-700" />
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Alertas activadas</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            Recibirá los avisos de su supervisor en este celular, aunque tenga la pantalla apagada.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel flex items-start gap-3 p-4">
      {state === 'bloqueado' ? (
        <BellOff className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-700" />
      ) : (
        <Bell className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-600" />
      )}
      <div className="flex-1">
        <h3 className="text-sm font-semibold text-slate-900">Alertas del supervisor</h3>

        {state === 'inactivo' && (
          <>
            <p className="mt-0.5 text-sm text-slate-600">
              Active las notificaciones para recibir avisos importantes aunque tenga la pantalla apagada.
            </p>
            <button type="button" onClick={handleEnable} disabled={busy} className="btn-primary btn-sm mt-3">
              {busy ? 'Activando…' : 'Activar alertas'}
            </button>
          </>
        )}

        {state === 'bloqueado' && (
          <p className="mt-0.5 text-sm text-red-800">
            Las notificaciones de esta app están bloqueadas. Para recibir alertas, actívelas en los ajustes del
            navegador (candado junto a la dirección → Notificaciones → Permitir) y vuelva aquí.
          </p>
        )}

        {state === 'ios-instalar' && (
          <p className="mt-0.5 text-sm text-amber-800">
            En iPhone o iPad las alertas solo funcionan con la app instalada: toque <strong>Compartir</strong> →{' '}
            <strong>Añadir a pantalla de inicio</strong> y abra SMI desde ese ícono.
          </p>
        )}

        {state === 'no-soportado' && (
          <p className="mt-0.5 text-sm text-slate-600">
            Este navegador no admite notificaciones. Use Chrome en Android o instale la app.
          </p>
        )}

        {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
      </div>
    </section>
  );
};
