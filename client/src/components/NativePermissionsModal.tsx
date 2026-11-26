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

  // Tocar el círculo o el texto de un paso pendiente hace lo mismo que su botón: abre el permiso en Android.
  // El check NO se marca con el toque: solo cuando el teléfono confirma que el permiso quedó concedido.
  const Paso: React.FC<{
    ok: boolean;
    titulo: string;
    detalle: string;
    boton?: string;
    onClick?: () => void;
    recomendado?: boolean;
    /** Ayudas adicionales del mismo paso (van antes de la línea separadora) */
    extra?: React.ReactNode;
  }> = ({ ok, titulo, detalle, boton, onClick, recomendado, extra }) => {
    const tocable = !ok && Boolean(onClick);
    const contenido = (
      <>
        {ok ? (
          <CheckCircle2 className="mt-0.5 h-6 w-6 flex-shrink-0 text-green-700" aria-label="Listo" />
        ) : (
          <Circle className="mt-0.5 h-6 w-6 flex-shrink-0 text-brand-600" aria-label="Pendiente" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">
            {titulo} {recomendado && !ok && <span className="tag ml-1">Recomendado</span>}
          </span>
          <span className="mt-0.5 block text-sm text-slate-600">{detalle}</span>
        </span>
      </>
    );
    return (
      <li className="border-b border-slate-200 py-3 last:border-b-0">
        {tocable ? (
          <button type="button" disabled={ocupado} onClick={onClick} className="flex w-full items-start gap-3 text-left">
            {contenido}
          </button>
        ) : (
          <div className="flex items-start gap-3">{contenido}</div>
        )}
        {(extra || (!ok && boton && onClick)) && (
          <div className="pl-9">
            {!ok && boton && onClick && (
              <button type="button" disabled={ocupado} onClick={onClick} className="btn btn-primary btn-sm mt-2">
                {boton}
              </button>
            )}
            {extra}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 sm:items-center sm:p-4">
      <div className="panel max-h-[92vh] w-full max-w-md overflow-y-auto p-5">
        <h2 className="text-base font-semibold text-slate-900">Configurar el rastreo del turno</h2>
        <p className="mt-1 text-sm text-slate-600">
          Para que su ubicación se registre con la pantalla apagada, la aplicación necesita estos permisos. Solo se
          configuran una vez. <strong>Toque cada círculo</strong> para activarlo: el check aparece cuando quede concedido.
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
            // Android solo deja pedir "todo el tiempo" después de la ubicación precisa: si falta, se pide primero esa
            onClick={() => ejecutar(() => (p.ubicacionPrecisa ? nativeTracker.pedirSegundoPlano() : nativeTracker.pedirUbicacion()))}
            extra={
              !p.segundoPlano && p.ubicacionPrecisa ? (
                <button type="button" disabled={ocupado} onClick={() => ejecutar(() => nativeTracker.abrirAjustes())} className="btn btn-secondary btn-sm mt-2">
                  Abrir ajustes de la aplicación
                </button>
              ) : null
            }
          />
          {necesitaNotif && (
            <Paso
              ok={p.notificaciones}
              titulo="Notificaciones"
              detalle="Se muestra un aviso fijo mientras su ubicación se registra, y le llegarán las alertas de la oficina."
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
            extra={
              /xiaomi|redmi|poco|samsung/i.test(est.fabricante) ? (
                <div className="mt-2">
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
                </div>
              ) : null
            }
          />
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
