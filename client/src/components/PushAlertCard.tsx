import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { enablePush, getPushState, type PushState } from '../services/push';

// Tarjeta del trabajador para activar las alertas del supervisor en su celular.
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
      setError(err.message || 'No se pudo activar. Intenta de nuevo.');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  // Mientras carga o si el servidor no las ofrece, no se muestra nada
  if (state === 'cargando' || state === 'no-disponible') return null;

  if (state === 'activo') {
    return (
      <div className="bg-emerald-950/50 border border-emerald-600/40 rounded-2xl p-3 flex items-start space-x-3">
        <BellRing className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
        <div>
          <h4 className="font-bold text-xs text-emerald-300">Alertas activadas</h4>
          <p className="text-[11px] text-emerald-200/70 leading-snug">
            Recibirás los avisos de tu supervisor en este celular, aunque tengas la pantalla apagada.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-800/70 border border-slate-700/80 rounded-2xl p-3 flex items-start space-x-3">
      {state === 'bloqueado' ? (
        <BellOff className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
      ) : (
        <Bell className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
      )}
      <div className="flex-1">
        <h4 className="font-bold text-xs text-white">Alertas del supervisor</h4>

        {state === 'inactivo' && (
          <>
            <p className="text-[11px] text-slate-400 leading-snug mb-2">
              Activa las notificaciones para recibir avisos importantes aunque tengas la pantalla apagada.
            </p>
            <button
              type="button"
              onClick={handleEnable}
              disabled={busy}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-[11px] font-bold rounded-lg transition active:scale-95"
            >
              {busy ? 'Activando…' : '🔔 Activar alertas'}
            </button>
          </>
        )}

        {state === 'bloqueado' && (
          <p className="text-[11px] text-rose-300 leading-snug">
            Bloqueaste las notificaciones de esta app. Para recibir alertas, actívalas en los ajustes del navegador
            (candado junto a la dirección → Notificaciones → Permitir) y vuelve aquí.
          </p>
        )}

        {state === 'ios-instalar' && (
          <p className="text-[11px] text-amber-200 leading-snug">
            En iPhone/iPad las alertas solo funcionan con la app instalada: toca <strong>Compartir</strong> →{' '}
            <strong>Añadir a pantalla de inicio</strong> y abre SMI desde ese ícono.
          </p>
        )}

        {state === 'no-soportado' && (
          <p className="text-[11px] text-slate-400 leading-snug">
            Este navegador no admite notificaciones. Prueba con Chrome (Android) o instala la app.
          </p>
        )}

        {error && <p className="text-[11px] text-rose-300 mt-1">{error}</p>}
      </div>
    </div>
  );
};
