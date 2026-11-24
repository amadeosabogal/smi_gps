import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { bateriaObligatoria, nativeTracker, permisosCompletos, type EstadoRastreo } from '../services/nativeTracker';

interface Props {
  onListo: () => void;
  onCancelar: () => void;
}

// Guía de permisos de la app Android. El rastreo con la pantalla apagada solo funciona si el trabajador
// concede la ubicación "todo el tiempo" y la app no queda restringida por el ahorro de batería.
export const NativePermissionsModal: React.FC<Props> = ({ onListo, onCancelar }) => {
  const [est, setEst] = useState<EstadoRastreo | null>(null);
  const [ocupado, setOcupado] = useState<boolean>(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const refrescar = useCallback(async () => {
    try {
      setEst(await nativeTracker.estado());
    } catch {
      /* se reintenta al volver a la app */
    }
  }, []);

  useEffect(() => {
    refrescar();
    // Los permisos de "todo el tiempo" y de batería se conceden en pantallas de Ajustes: al volver se revisa de nuevo
    const alVolver = () => {
      if (document.visibilityState === 'visible') refrescar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [refrescar]);

  const ejecutar = async (accion: () => Promise<unknown>) => {
    setOcupado(true);
    setAviso(null);
    try {
      await accion();
    } catch (err: any) {
      setAviso(err?.message || 'No se pudo completar este paso.');
    } finally {
      await refrescar();
      setOcupado(false);
    }
  };

  if (!est) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
        <div className="panel w-full max-w-md p-6 text-center text-sm text-slate-600">Revisando permisos…</div>
      </div>
    );
  }

  const p = est.permisos;
  const exigeBateria = bateriaObligatoria(est.fabricante);
  const necesitaNotif = est.android >= 33;
  const listo = permisosCompletos(est);

  const Paso: React.FC<{
    ok: boolean;
    titulo: string;
    detalle: string;
    boton?: string;
    onClick?: () => void;
    recomendado?: boolean;
  }> = ({ ok, titulo, detalle, boton, onClick, recomendado }) => (
    <li className="flex items-start gap-3 border-b border-slate-200 py-3 last:border-b-0">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-700" />
      ) : (
        <Circle className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">
          {titulo} {recomendado && !ok && <span className="tag ml-1">Recomendado</span>}
        </p>
        <p className="mt-0.5 text-sm text-slate-600">{detalle}</p>
        {!ok && boton && onClick && (
          <button type="button" disabled={ocupado} onClick={onClick} className="btn btn-primary btn-sm mt-2">
            {boton}
          </button>
        )}
      </div>
    </li>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 sm:items-center sm:p-4">
      <div className="panel max-h-[92vh] w-full max-w-md overflow-y-auto p-5">
        <h2 className="text-base font-semibold text-slate-900">Configurar el rastreo del turno</h2>
        <p className="mt-1 text-sm text-slate-600">
          Para que su ubicación se registre con la pantalla apagada, la aplicación necesita estos permisos. Solo se
          configuran una vez.
        </p>

        <ul className="mt-3">
          <Paso
            ok={p.ubicacionActivada}
            titulo="Ubicación del teléfono encendida"
            detalle="Active la ubicación (GPS) desde el panel de ajustes rápidos o en Ajustes → Ubicación."
            boton="Abrir ajustes"
            onClick={() => ejecutar(() => nativeTracker.abrirAjustesUbicacion())}
          />
          <Paso
            ok={p.ubicacionPrecisa}
            titulo="Ubicación precisa"
            detalle='Elija "Precisa" (no "Aproximada") y "Mientras la app está en uso".'
            boton="Permitir"
            onClick={() => ejecutar(() => nativeTracker.pedirUbicacion())}
          />
          <Paso
            ok={p.segundoPlano}
            titulo='Ubicación "Permitir todo el tiempo"'
            detalle='Es lo que permite seguir registrando con la pantalla apagada. En Ajustes → Permisos → Ubicación, marque "Permitir todo el tiempo".'
            boton={p.ubicacionPrecisa ? 'Permitir todo el tiempo' : undefined}
            onClick={() => ejecutar(() => nativeTracker.pedirSegundoPlano())}
          />
          {!p.segundoPlano && p.ubicacionPrecisa && (
            <li className="pb-2 pl-8">
              <button type="button" disabled={ocupado} onClick={() => ejecutar(() => nativeTracker.abrirAjustes())} className="btn btn-secondary btn-sm">
                Abrir ajustes de la aplicación
              </button>
            </li>
          )}
          {necesitaNotif && (
            <Paso
              ok={p.notificaciones}
              titulo="Notificaciones"
              detalle="Se muestra un aviso fijo mientras su ubicación se registra, y le llegarán las alertas del supervisor."
              boton="Permitir"
              onClick={() => ejecutar(() => nativeTracker.pedirNotificaciones())}
            />
          )}
          <Paso
            ok={p.bateriaSinRestriccion}
            recomendado={!exigeBateria}
            titulo="Batería sin restricciones"
            detalle={
              exigeBateria
                ? `Su teléfono (${est.fabricante}) cierra las aplicaciones en segundo plano. Permita que esta aplicación no se restrinja o dejará de registrar su ubicación.`
                : 'Evita que el sistema pause la aplicación para ahorrar batería durante el turno.'
            }
            boton="Quitar restricción"
            onClick={() => ejecutar(() => nativeTracker.pedirBateria())}
          />
          {(/xiaomi|redmi|poco|samsung/i.test(est.fabricante) || false) && (
            <li className="pb-1 pl-8">
              <p className="text-xs text-slate-600">
                {/samsung/i.test(est.fabricante)
                  ? 'Samsung: en Ajustes → Batería → Límites de uso en segundo plano, quite esta aplicación de "Apps en suspensión".'
                  : 'Xiaomi: active además el "Inicio automático" de esta aplicación y elija "Sin restricciones" en Ahorro de batería.'}
              </p>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => ejecutar(async () => {
                  const r = await nativeTracker.abrirAjustesFabricante();
                  if (!r.abierto) await nativeTracker.abrirAjustes();
                })}
                className="btn btn-secondary btn-sm mt-1"
              >
                Abrir ajustes del fabricante
              </button>
            </li>
          )}
        </ul>

        {aviso && <p className="mt-2 text-sm text-red-800">{aviso}</p>}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onCancelar} className="btn btn-secondary flex-1">
            Cancelar
          </button>
          <button type="button" disabled={!listo || ocupado} onClick={onListo} className="btn btn-primary flex-1 disabled:opacity-50">
            {listo ? 'Continuar' : 'Complete los pasos'}
          </button>
        </div>
      </div>
    </div>
  );
};
