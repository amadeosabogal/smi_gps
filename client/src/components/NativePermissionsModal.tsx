import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { bateriaObligatoria, nativeTracker, permisosCompletos, type EstadoRastreo } from '../services/nativeTracker';
import { esSamsung, pasoActual, pasosDePermisos, type IdPaso } from '../services/pasosPermisos';
import { DibujoPermiso } from './DibujoPermiso';

interface Props {
  onListo: () => void;
  onCancelar: () => void;
}

// Asistente de permisos de la app Android: un botón para empezar y luego un paso a la vez, con un dibujo de dónde
// tocar. Los ya concedidos se saltan solos. El rastreo con la pantalla apagada solo funciona si el trabajador concede
// la ubicación "todo el tiempo" y la app no queda restringida por el ahorro de batería.

const ESPERA_VENTANA_MS = 1500; // tiempo para leer la instrucción antes de que la app abra la ventana de Android
const ESPERA_FINAL_MS = 1800; // cuánto se ve "Listo" antes de continuar con la marcación
const REVISAR_MS = 1500; // las ventanas pequeñas de Android no siempre avisan al cerrarse

const ACCIONES: Record<IdPaso, () => Promise<unknown>> = {
  ubicacion: () => nativeTracker.abrirAjustesUbicacion(),
  precisa: () => nativeTracker.pedirUbicacion(),
  todo: () => nativeTracker.pedirSegundoPlano(),
  notificaciones: () => nativeTracker.pedirNotificaciones(),
  bateria: () => nativeTracker.pedirBateria(),
  fabricante: async () => {
    const r = await nativeTracker.abrirAjustesFabricante();
    if (!r.abierto) await nativeTracker.abrirAjustes();
  },
};

const NOMBRE: Record<IdPaso, string> = {
  ubicacion: 'Ubicación encendida',
  precisa: 'Ubicación precisa',
  todo: 'Ubicación "todo el tiempo"',
  notificaciones: 'Notificaciones',
  bateria: 'Batería sin restricciones',
  fabricante: 'Ajuste del fabricante',
};

function textos(id: IdPaso, est: EstadoRastreo): { titulo: string; instruccion: string; ayuda: string } {
  const samsung = esSamsung(est.fabricante);
  switch (id) {
    case 'ubicacion':
      return {
        titulo: 'Encienda la ubicación',
        instruccion: 'Toque "Abrir ajustes", encienda la ubicación y vuelva a la aplicación.',
        ayuda: 'También puede encenderla desde el panel que se baja desde la parte superior del teléfono.',
      };
    case 'precisa':
      return {
        titulo: 'Permita su ubicación',
        instruccion: 'En la ventana de Android elija "Precisa" y "Mientras la app está en uso".',
        ayuda: est.permisos.ubicacionAproximada
          ? 'Quedó la ubicación aproximada: en los ajustes de la aplicación, en Ubicación, active "Usar ubicación precisa".'
          : 'Si la ventana no aparece, abra los ajustes de la aplicación, entre a Permisos y luego a Ubicación.',
      };
    case 'todo':
      return {
        titulo: 'Permitir todo el tiempo',
        instruccion: 'Toque "Abrir ajustes", elija "Permitir todo el tiempo" y vuelva atrás. Así se registra con la pantalla apagada.',
        ayuda: 'Si no se abrió esa pantalla, abra los ajustes de la aplicación, entre a Permisos y luego a Ubicación.',
      };
    case 'notificaciones':
      return {
        titulo: 'Permita las notificaciones',
        instruccion: 'En la ventana de Android toque "Permitir". Así le llegan los recordatorios y las alertas de la oficina.',
        ayuda: 'Si la ventana no aparece, active las notificaciones en los ajustes de la aplicación.',
      };
    case 'bateria':
      return {
        titulo: 'Quite la restricción de batería',
        instruccion: 'En la ventana de Android toque "Permitir", para que el teléfono no cierre la aplicación durante su turno.',
        ayuda: 'Si la ventana no aparece, en los ajustes de la aplicación entre a Batería y elija "Sin restricciones".',
      };
    default:
      return {
        titulo: `Último ajuste para su ${samsung ? 'Samsung' : 'Xiaomi'}`,
        instruccion: samsung
          ? 'Toque "Abrir ajustes" y, en Batería, quite esta aplicación de "Apps en suspensión". Luego vuelva aquí.'
          : 'Toque "Abrir ajustes", active "Inicio automático" y elija "Sin restricciones" en Ahorro de batería. Luego vuelva aquí.',
        ayuda: 'Si ya lo hizo antes, continúe.',
      };
  }
}

export const NativePermissionsModal: React.FC<Props> = ({ onListo, onCancelar }) => {
  const [est, setEst] = useState<EstadoRastreo | null>(null);
  const [ocupado, setOcupado] = useState<boolean>(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [empezado, setEmpezado] = useState<boolean>(false);
  const [elegido, setElegido] = useState<IdPaso | null>(null);
  const [omitidos, setOmitidos] = useState<ReadonlySet<IdPaso>>(new Set());
  const [intentados, setIntentados] = useState<ReadonlySet<IdPaso>>(new Set());
  const continuar = useRef(onListo);
  continuar.current = onListo;

  const refrescar = useCallback(async () => {
    try {
      setEst(await nativeTracker.estado());
    } catch {
      /* se reintenta en la siguiente revisión */
    }
  }, []);

  useEffect(() => {
    refrescar();
    const alVolver = () => {
      if (document.visibilityState === 'visible') refrescar();
    };
    document.addEventListener('visibilitychange', alVolver);
    const t = setInterval(alVolver, REVISAR_MS);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      clearInterval(t);
    };
  }, [refrescar]);

  const lanzar = useCallback(
    async (id: IdPaso) => {
      setIntentados((prev) => new Set(prev).add(id));
      setOcupado(true);
      setAviso(null);
      try {
        await ACCIONES[id]();
      } catch (err: any) {
        setAviso(err?.message || 'No se pudo abrir este paso.');
      } finally {
        await refrescar();
        setOcupado(false);
      }
    },
    [refrescar]
  );

  const pasos = est ? pasosDePermisos(est, bateriaObligatoria(est.fabricante)) : [];
  const actual = empezado ? pasoActual(pasos, omitidos, elegido) : null;
  const terminado = Boolean(est && empezado && !actual && permisosCompletos(est));

  // Las ventanas de Android se abren solas, una vez por paso; a las pantallas de ajustes se va con un toque
  const idVentana = actual?.modo === 'ventana' && !intentados.has(actual.id) ? actual.id : null;
  useEffect(() => {
    if (!idVentana || ocupado) return;
    const t = setTimeout(() => lanzar(idVentana), ESPERA_VENTANA_MS);
    return () => clearTimeout(t);
  }, [idVentana, ocupado, lanzar]);

  useEffect(() => {
    if (!terminado) return;
    const t = setTimeout(() => continuar.current(), ESPERA_FINAL_MS);
    return () => clearTimeout(t);
  }, [terminado]);

  const omitir = (id: IdPaso) => {
    setElegido(null);
    setOmitidos((prev) => new Set(prev).add(id));
  };

  const empezarEn = (id: IdPaso | null) => {
    setElegido(id);
    setEmpezado(true);
  };

  const marco = (contenido: React.ReactNode) => (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 sm:items-center sm:p-4">
      <div className="panel max-h-[92vh] w-full max-w-md overflow-y-auto p-5">{contenido}</div>
    </div>
  );

  if (!est) return marco(<p className="py-2 text-center text-sm text-slate-600">Revisando permisos…</p>);

  if (terminado) {
    return marco(
      <div className="text-center">
        <CheckCircle2 className="mx-auto h-14 w-14 text-green-700" />
        <h2 className="mt-2 text-lg font-semibold text-slate-900">Listo</h2>
        <p className="mt-1 text-sm text-slate-600">Los permisos quedaron configurados. Continuamos con su entrada…</p>
        <button type="button" onClick={() => continuar.current()} className="btn btn-primary mt-4 w-full">
          Continuar ahora
        </button>
      </div>
    );
  }

  // Un paso a la vez
  if (actual) {
    const t = textos(actual.id, est);
    const numero = pasos.findIndex((p) => p.id === actual.id) + 1;
    const intentado = intentados.has(actual.id);
    const esFabricante = actual.id === 'fabricante';
    return marco(
      <>
        <div className="flex gap-1" aria-hidden="true">
          {pasos.map((p) => (
            <span key={p.id} className={`h-1.5 flex-1 ${p.ok ? 'bg-green-600' : p.id === actual.id ? 'bg-brand-600' : 'bg-slate-200'}`} />
          ))}
        </div>
        <p className="mt-3 text-xs font-semibold text-slate-500">
          Paso {numero} de {pasos.length}
          {!actual.obligatorio && ' · opcional'}
        </p>
        <h2 className="mt-0.5 text-lg font-semibold text-slate-900">{t.titulo}</h2>
        <p className="mt-1 text-base leading-snug text-slate-700">{t.instruccion}</p>

        <div className="mt-3">
          <DibujoPermiso paso={actual.id} samsung={esSamsung(est.fabricante)} />
        </div>

        {intentado && !ocupado && <p className="mt-3 text-sm text-slate-600">{t.ayuda}</p>}
        {aviso && <p className="mt-2 text-sm text-red-800">{aviso}</p>}

        <button type="button" disabled={ocupado} onClick={() => lanzar(actual.id)} className="btn btn-primary mt-4 w-full py-3 text-base">
          {actual.modo === 'ajustes' ? 'Abrir ajustes' : intentado ? 'Intentar de nuevo' : 'Abriendo… toque si no aparece'}
        </button>
        {intentado && !esFabricante && actual.id !== 'ubicacion' && (
          <button
            type="button"
            disabled={ocupado}
            onClick={() => nativeTracker.abrirAjustes().catch(() => {})}
            className="btn btn-secondary mt-2 w-full"
          >
            Abrir ajustes de la aplicación
          </button>
        )}
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={onCancelar} className="btn btn-secondary flex-1">
            Cancelar
          </button>
          {!actual.obligatorio && (
            <button type="button" onClick={() => omitir(actual.id)} className="btn btn-secondary flex-1">
              {esFabricante && intentado ? 'Ya lo hice' : 'Saltar'}
            </button>
          )}
        </div>
      </>
    );
  }

  // Pantalla inicial: un botón. También se puede tocar el círculo de un paso para empezar por él.
  return marco(
    <>
      <h2 className="text-base font-semibold text-slate-900">Configurar el rastreo del turno</h2>
      <p className="mt-1 text-sm text-slate-600">
        Son permisos de Android que se dan <strong>una sola vez</strong>. La aplicación se los pide uno por uno y le muestra dónde
        tocar.
      </p>

      <ul className="mt-3">
        {pasos
          .filter((p) => p.id !== 'fabricante')
          .map((p) => (
            <li key={p.id} className="border-b border-slate-200 last:border-b-0">
              <button type="button" disabled={p.ok} onClick={() => empezarEn(p.id)} className="flex w-full items-center gap-3 py-2 text-left">
                {p.ok ? (
                  <CheckCircle2 className="h-6 w-6 flex-shrink-0 text-green-700" aria-label="Listo" />
                ) : (
                  <Circle className="h-6 w-6 flex-shrink-0 text-brand-600" aria-label="Pendiente" />
                )}
                <span className="text-sm font-medium text-slate-900">{NOMBRE[p.id]}</span>
                {!p.obligatorio && !p.ok && <span className="tag ml-auto">Recomendado</span>}
              </button>
            </li>
          ))}
      </ul>

      <button type="button" onClick={() => empezarEn(null)} className="btn btn-primary mt-4 w-full py-3 text-base">
        Activar permisos
      </button>
      <button type="button" onClick={onCancelar} className="btn btn-secondary mt-2 w-full">
        Cancelar
      </button>
    </>
  );
};
