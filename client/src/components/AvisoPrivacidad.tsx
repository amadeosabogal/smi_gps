import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../services/api';
import { BrandLogo } from './BrandLogo';
import type { InfoPrivacidad } from '../types';

interface Props {
  onAceptado: () => void;
  onRechazar: () => void;
}

const plazo = (dias: number, que: string) =>
  dias > 0 ? `${que}: se borran a los ${dias} días.` : `${que}: se conservan el tiempo que defina la empresa.`;

const Seccion: React.FC<{ titulo: string; children: React.ReactNode; abierta?: boolean }> = ({ titulo, children, abierta }) => (
  <details open={abierta} className="border border-slate-300 bg-white">
    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">{titulo}</summary>
    <div className="space-y-2 border-t border-slate-200 px-4 py-3 text-sm leading-relaxed text-slate-700">{children}</div>
  </details>
);

// Aviso de privacidad y autorización del trabajador (se muestra antes del primer uso y cuando cambia el aviso)
export const AvisoPrivacidad: React.FC<Props> = ({ onAceptado, onRechazar }) => {
  const [info, setInfo] = useState<InfoPrivacidad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rostro, setRostro] = useState(false);
  const [ubicacion, setUbicacion] = useState(false);
  const [datos, setDatos] = useState(false);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    let vivo = true;
    api.getPrivacyInfo().then((i) => vivo && setInfo(i)).catch((e) => vivo && setError(e.message || 'No se pudo cargar el aviso'));
    return () => {
      vivo = false;
    };
  }, []);

  const e = info?.empresa;
  const empresa = e?.nombre || 'su empleador';
  const completo = rostro && ubicacion && datos;

  const aceptar = async () => {
    setEnviando(true);
    setError(null);
    try {
      await api.acceptPrivacy();
      onAceptado();
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar su autorización');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-6" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)' }}>
      <div className="mx-auto w-full max-w-xl space-y-3">
        <div className="border border-slate-300 bg-white p-5">
          <BrandLogo variant="azul" className="mb-4 h-9 w-auto" />
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 flex-shrink-0 place-items-center bg-brand-600 text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">Aviso de privacidad</h1>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">
                Antes de usar la aplicación, lea cómo se usan sus datos. {empresa} es responsable de protegerlos. Toque cada título para leerlo.
              </p>
            </div>
          </div>
        </div>

        {!info && !error && <p className="py-6 text-center text-sm text-slate-600">Cargando…</p>}

        {info && (
          <>
            <Seccion titulo="Quién es responsable" abierta>
              <p>
                <strong>{empresa}</strong>
                {e?.ruc ? ` · RUC ${e.ruc}` : ''}
                {e?.domicilio ? ` · ${e.domicilio}` : ''}.
              </p>
              {e?.correoDatos && (
                <p>
                  Consultas, reclamos y ejercicio de sus derechos: <strong>{e.correoDatos}</strong>
                </p>
              )}
              {e?.proveedor && <p>La aplicación la mantiene {e.proveedor}, solo por encargo de la empresa.</p>}
            </Seccion>

            <Seccion titulo="Qué datos se recogen y para qué">
              <p>
                Se usan solo para registrar su asistencia, comprobar que está en su lugar de trabajo durante el turno, coordinar su trabajo y
                seguridad, calcular su tiempo trabajado (incluido el almuerzo) y prevenir fraudes.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Nombre, código, cargo, correo y teléfono; su PIN se guarda cifrado.</li>
                <li>
                  <strong>Rostro (dato biométrico, sensible):</strong> una foto de referencia, una huella numérica (una lista de números, no una imagen)
                  y una foto en cada verificación, con el porcentaje de parecido.
                </li>
                <li>Los gestos de la prueba de vida (girar la cabeza, sonreír, abrir la boca, parpadear). No se graba video.</li>
                <li>Hora de entrada y salida, estación y horario de almuerzo.</li>
                <li>Ubicación GPS (latitud, longitud, precisión y hora) y si está dentro de su estación.</li>
                <li>Batería del teléfono y si está cargando (app Android) y un código técnico del dispositivo creado por la propia aplicación.</li>
                <li>Avisos de su supervisor y si los leyó; intentos rechazados o sospechosos, con foto cuando es de rostro.</li>
                <li>Registros técnicos del servidor (fecha, hora y dirección IP).</li>
              </ul>
            </Seccion>

            <Seccion titulo="Cuándo se activan el GPS y la cámara">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  El GPS se registra <strong>solo mientras su turno está activo</strong>, desde que marca la entrada hasta que marca la salida. Fuera
                  del turno no se registra su ubicación.
                </li>
                <li>
                  En Android, el teléfono pide el permiso “Permitir todo el tiempo” y muestra una notificación fija mientras el rastreo está en
                  marcha.
                </li>
                <li>
                  <strong>Durante el almuerzo el GPS sigue registrando</strong>, porque el almuerzo ocurre dentro del turno.
                </li>
                <li>La cámara se enciende solo cuando va a marcar (entrada, salida o almuerzo) o a registrar su rostro. Nunca se envía video.</li>
              </ul>
            </Seccion>

            <Seccion titulo="Lo que la aplicación no hace">
              <ul className="list-disc space-y-1 pl-5">
                <li>No sigue su ubicación fuera del turno.</li>
                <li>No graba video ni audio y no usa el micrófono.</li>
                <li>No lee sus contactos, mensajes, llamadas, fotos, archivos ni otras aplicaciones.</li>
                <li>No vende ni cede sus datos con fines comerciales o publicitarios.</li>
                <li>No sanciona de forma automática: una alerta solo avisa a una persona, que debe revisarla.</li>
              </ul>
            </Seccion>

            <Seccion titulo="Quién ve sus datos">
              <ul className="list-disc space-y-1 pl-5">
                <li>Administradores y supervisores de la empresa, con usuario y clave propios. Otros trabajadores no ven nada suyo.</li>
                <li>El proveedor de la aplicación y del servidor, solo para mantenimiento{e?.paisServidor ? ` (servidor en ${e.paisServidor})` : ''}.</li>
                <li>Google Maps dibuja el mapa del panel de los administradores; no recibe su nombre ni sus fotos.</li>
                <li>Las autoridades, solo lo que una ley u orden competente exija.</li>
              </ul>
            </Seccion>

            <Seccion titulo="Cuánto tiempo se guardan y sus derechos">
              <ul className="list-disc space-y-1 pl-5">
                <li>{plazo(info.plazos.gpsDias, 'Puntos GPS del recorrido')}</li>
                <li>{plazo(info.plazos.fotosDias, 'Fotos de verificación')}</li>
                <li>{plazo(info.plazos.registrosDias, 'Asistencias, alertas y avisos')}</li>
                <li>
                  Su foto de referencia y huella del rostro se eliminan dentro de {e?.diasRostroTrasCese || 30} días después de terminar su
                  relación laboral, salvo que una ley exija conservarlas.
                </li>
              </ul>
              <p>
                Tiene derecho a saber qué datos suyos se tratan, pedir una copia, corregirlos, pedir que se eliminen, oponerse a un uso y
                retirar su autorización cuando quiera (Ley N.º 29733). Escriba a {e?.correoDatos || 'la empresa'} indicando su nombre y código. Si no
                está conforme, puede reclamar ante la Autoridad Nacional de Protección de Datos Personales.
              </p>
            </Seccion>

            <div className="border border-slate-300 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">Mi autorización</h2>
              <p className="mt-1 text-sm text-slate-600">
                Autorizo de forma libre, previa, expresa e informada a {empresa} a tratar mis datos para los fines y plazos indicados.
              </p>
              <div className="mt-3 space-y-3">
                <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-800">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={rostro} onChange={(ev) => setRostro(ev.target.checked)} />
                  <span>
                    <strong>Rostro (datos biométricos, sensibles).</strong> Autorizo mi foto de referencia, la huella numérica de mi rostro y una foto
                    en cada verificación, para comprobar mi identidad al marcar.
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-800">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={ubicacion} onChange={(ev) => setUbicacion(ev.target.checked)} />
                  <span>
                    <strong>Ubicación.</strong> Autorizo el registro de mi ubicación GPS y de la batería de mi teléfono solo mientras mi turno esté
                    activo, incluido el almuerzo.
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-800">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={datos} onChange={(ev) => setDatos(ev.target.checked)} />
                  <span>
                    <strong>Datos de identificación y asistencia.</strong> Autorizo el tratamiento de mi nombre, código, cargo, horas de entrada y
                    salida y demás datos indicados, para calcular mi tiempo trabajado.
                  </span>
                </label>
              </div>

              {error && (
                <p role="alert" className="mt-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {error}
                </p>
              )}

              <button type="button" onClick={aceptar} disabled={!completo || enviando} className="btn-primary mt-4 w-full">
                {enviando ? 'Guardando…' : 'Acepto y continuar'}
              </button>
              <button type="button" onClick={onRechazar} className="btn-secondary mt-2 w-full">
                No acepto
              </button>
              <p className="mt-3 text-xs leading-relaxed text-slate-500">
                Es libre de no autorizar. Sin estas autorizaciones la aplicación no puede registrar su asistencia
                {e?.alternativa ? `; en ese caso: ${e.alternativa}` : ''}.
              </p>
            </div>
          </>
        )}

        {error && !info && (
          <div className="border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            <p role="alert">{error}</p>
            <button type="button" onClick={onRechazar} className="btn-secondary mt-3 w-full">
              Cerrar sesión
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
