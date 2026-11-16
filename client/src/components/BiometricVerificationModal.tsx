import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, X, RotateCcw, Eye, ArrowLeft, ArrowRight } from 'lucide-react';
import { faceRecognitionService } from '../services/faceRecognition';
import { eyeBlinkService } from '../services/eyeBlink';
import {
  EjecutorRetos,
  generarSecuencia,
  distanciaDescriptores,
  DISTANCIA_MAX_CONTINUIDAD,
  TEXTO_RETO,
  type EstadoRetos,
  type MotivoFallo,
  type TipoReto,
} from '../services/livenessChallenges';
import { api } from '../services/api';
import type { Usuario, TipoVerificacion } from '../types';

interface BiometricVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  tipo: TipoVerificacion;
  worker: Usuario;
  onVerificationSuccess: (result: {
    photoBase64: string;
    similarity: number;
    isVerified: boolean;
  }) => void;
}

type StepState = 'ready' | 'processing' | 'success' | 'fraud_mismatch' | 'no_face';
type Fallo = MotivoFallo | 'continuidad' | null;

const ETIQUETA_TIPO: Record<TipoVerificacion, string> = {
  entrada: 'Entrada',
  salida: 'Salida',
  almuerzo_inicio: 'Inicio de almuerzo',
  almuerzo_fin: 'Fin de almuerzo',
};

const MENSAJE_FALLO: Record<Exclude<Fallo, null>, string> = {
  tiempo: 'No se completó el movimiento a tiempo. Se le pedirá algo distinto: intente de nuevo.',
  sin_rostro: 'Se perdió de vista su rostro. Colóquelo dentro del recuadro e intente de nuevo.',
  inestable: 'No se pudo comenzar. Mire de frente a la cámara, con buena luz, y quédese quieto un momento.',
  continuidad: 'No se pudo confirmar que fuera la misma persona durante toda la prueba. Intente de nuevo.',
};

// Intentos fallidos de la prueba de vida: tras 3 en 10 minutos se bloquea 2 minutos y los intentos quedan en la auditoría
const CLAVE_FALLOS = 'smi_liveness_fallos';
const MAX_FALLOS = 3;
const VENTANA_FALLOS_MS = 10 * 60 * 1000;
const BLOQUEO_MS = 2 * 60 * 1000;

const leerFallos = (): number[] => {
  try {
    const v = JSON.parse(sessionStorage.getItem(CLAVE_FALLOS) || '[]') as number[];
    return v.filter((t) => Date.now() - t < VENTANA_FALLOS_MS);
  } catch {
    return [];
  }
};
const guardarFallos = (v: number[]) => {
  try {
    sessionStorage.setItem(CLAVE_FALLOS, JSON.stringify(v));
  } catch {
    /* almacenamiento no disponible */
  }
};

export const BiometricVerificationModal: React.FC<BiometricVerificationModalProps> = ({
  isOpen,
  onClose,
  tipo,
  worker,
  onVerificationSuccess,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Estados del modal
  const [step, setStep] = useState<StepState>('ready');
  const [statusMessage, setStatusMessage] = useState<string>('Iniciando cámara frontal…');
  const [secuencia, setSecuencia] = useState<TipoReto[]>(() => generarSecuencia());
  const [retoEstado, setRetoEstado] = useState<EstadoRetos | null>(null);
  const [fallo, setFallo] = useState<Fallo>(null);
  const [bloqueadoHasta, setBloqueadoHasta] = useState<number>(0);
  const [ahoraTick, setAhoraTick] = useState<number>(Date.now());
  const [livenessDebug, setLivenessDebug] = useState<string>('');
  const [blinkModuleState, setBlinkModuleState] = useState<'loading' | 'ready' | 'error'>(
    eyeBlinkService.isReady() ? 'ready' : 'loading'
  );
  const [similarityScore, setSimilarityScore] = useState<number>(0);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState<boolean>(false);

  // Descriptor facial del inicio de la prueba: al final debe ser la MISMA cara (evita cambiar de persona o de foto)
  const descInicioRef = useRef<number[] | null>(null);

  // Detener hardware de la cámara
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Reinicia la prueba con una secuencia NUEVA de movimientos
  const nuevaPrueba = useCallback(() => {
    setSecuencia(generarSecuencia());
    setRetoEstado(null);
    setFallo(null);
    descInicioRef.current = null;
  }, []);

  // Reanudar cámara en vivo (descongelar) de forma instantánea
  const resumeCamera = useCallback(() => {
    setCapturedPhoto(null);
    setStep('ready');
    setErrorMessage(null);
    nuevaPrueba();
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [nuevaPrueba]);

  // Iniciar cámara frontal
  const startCamera = useCallback(async () => {
    setCameraReady(false);
    setCapturedPhoto(null);
    nuevaPrueba();
    setStep('ready');
    setStatusMessage('Iniciando cámara frontal…');
    setErrorMessage(null);

    // Si el stream ya existe y sigue activo, simplemente reactivar
    if (streamRef.current && streamRef.current.active && videoRef.current) {
      try {
        await videoRef.current.play();
        setCameraReady(true);
        return;
      } catch {
        // Fallback a reinicio normal
      }
    }

    try {
      // Iniciar cámara y cargar modelos en paralelo para máxima velocidad
      // El módulo de prueba de vida (wasm pesado) se descarga en segundo plano y NO bloquea la cámara
      setBlinkModuleState(eyeBlinkService.isReady() ? 'ready' : 'loading');
      eyeBlinkService.load().then((ok) => setBlinkModuleState(ok ? 'ready' : 'error'));

      const [mediaStream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        }),
        faceRecognitionService.loadModels(),
      ]);

      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(() => {});
          setCameraReady(true);
        };
      }
    } catch (err: any) {
      console.error('Error al iniciar cámara:', err);
      setErrorMessage(
        err?.name === 'NotAllowedError'
          ? 'Se denegó el acceso a la cámara. Permítalo en los ajustes del navegador.'
          : err?.name === 'NotFoundError'
          ? 'No se encontró una cámara en este dispositivo.'
          : 'No se pudo acceder a la cámara frontal.'
      );
      setStatusMessage('Error de cámara');
    }
  }, [nuevaPrueba]);

  useEffect(() => {
    if (isOpen) {
      startCamera();
      // Si hay un bloqueo vigente por demasiados intentos, se respeta
      try {
        const hasta = Number(sessionStorage.getItem(CLAVE_FALLOS + '_hasta') || 0);
        setAhoraTick(Date.now());
        setBloqueadoHasta(hasta > Date.now() ? hasta : 0);
      } catch {
        setBloqueadoHasta(0);
      }
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  // Cuenta regresiva del bloqueo
  useEffect(() => {
    if (!bloqueadoHasta) return;
    const t = setInterval(() => {
      setAhoraTick(Date.now());
      if (Date.now() >= bloqueadoHasta) setBloqueadoHasta(0);
    }, 1000);
    return () => clearInterval(t);
  }, [bloqueadoHasta]);

  // Capturar fotograma optimizado con marca de agua (escala eficiente máx 640px para cero lag)
  const captureSnapshot = (): string | null => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    const vWidth = video.videoWidth || 640;
    const vHeight = video.videoHeight || 480;

    // Escalar proporcionalmente a máx 640px para encoding instantáneo sin lag
    const maxDimension = 640;
    const scale = Math.min(1, maxDimension / Math.max(vWidth, vHeight));
    const targetWidth = Math.round(vWidth * scale);
    const targetHeight = Math.round(vHeight * scale);

    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Efecto espejo selfie
    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Marca de agua de seguridad SMI
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(0, canvas.height - 30, canvas.width, 30);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 11px Archivo, sans-serif';
    const timestamp = `SMI BIOMÉTRICO: ${worker.nombre} - ${new Date().toLocaleString()} [${tipo.toUpperCase()}]`;
    ctx.fillText(timestamp, 10, canvas.height - 10);

    return canvas.toDataURL('image/jpeg', 0.82);
  };

  // Anota un intento fallido de la prueba de vida. Desde el 2.º seguido queda en la auditoría de fraude con su foto
  // (así se ve, por ejemplo, un video frente a la cámara), y al 3.º se bloquea unos minutos.
  const registrarFallo = (motivo: Fallo) => {
    const lista = [...leerFallos(), Date.now()];
    guardarFallos(lista);
    if (lista.length >= 2) {
      const foto = captureSnapshot();
      if (foto) api.reportLivenessFail(foto, String(motivo || 'desconocido'), lista.length).catch(() => {});
    }
    if (lista.length >= MAX_FALLOS) {
      const hasta = Date.now() + BLOQUEO_MS;
      try {
        sessionStorage.setItem(CLAVE_FALLOS + '_hasta', String(hasta));
      } catch {
        /* almacenamiento no disponible */
      }
      guardarFallos([]);
      setAhoraTick(Date.now());
      setBloqueadoHasta(hasta);
    }
  };

  // Botón Principal: Disparar captura y validar inmediatamente sin pantalla negra
  const handleCaptureAndValidate = async () => {
    if (step === 'processing' || !videoRef.current || !cameraReady) return;

    const video = videoRef.current;

    // 1. Congelar inmediatamente el video (0ms de retraso, SIN pantalla negra)
    try {
      video.pause();
    } catch (e) {
      console.warn('Error congelando video:', e);
    }

    setStep('processing');
    setStatusMessage('Analizando rostro…');

    // Permitir un microciclo de renderizado para mostrar la congelación y el loader
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));

    try {
      // 2. Extraer descriptor biométrico DIRECTAMENTE de la textura de video activa (máxima velocidad WebGL)
      const tStart = performance.now();
      const detection = await faceRecognitionService.detectFullFace(video);
      const tDescriptor = performance.now() - tStart;

      if (!detection) {
        setStep('no_face');
        setStatusMessage('No se detectó un rostro claro. Intente de nuevo.');
        return;
      }

      const liveDescriptor = Array.from(detection.descriptor);

      // 2b. Continuidad: la cara del final debe ser la misma que la del inicio de la prueba
      if (descInicioRef.current) {
        const dist = distanciaDescriptores(descInicioRef.current, liveDescriptor);
        if (dist > DISTANCIA_MAX_CONTINUIDAD) {
          console.warn(`[BIOMETRÍA] la cara cambió durante la prueba (distancia ${dist.toFixed(2)})`);
          registrarFallo('continuidad');
          setFallo('continuidad');
          setStep('ready');
          video.play().catch(() => {});
          return;
        }
      }

      // 3. Generar snapshot fotográfico en memoria con marca de agua
      const snapshot = captureSnapshot();
      if (!snapshot) {
        setErrorMessage('No se pudo generar la evidencia fotográfica.');
        setStep('no_face');
        return;
      }
      setCapturedPhoto(snapshot);

      const finishSuccess = (similarity: number, message: string) => {
        guardarFallos([]);
        setSimilarityScore(similarity);
        setStep('success');
        setStatusMessage(message);
        stopCamera();
        setTimeout(() => {
          onClose();
          onVerificationSuccess({ photoBase64: snapshot, similarity, isVerified: true });
        }, 150);
      };

      // 4. Caso A: el trabajador aún no tiene rostro enrolado (auto-enrolamiento, lo valida el servidor)
      if (!worker.facial_enrolado) {
        setStatusMessage('Registrando su rostro por primera vez…');
        await api.enrolSelf(liveDescriptor, snapshot, tipo);
        finishSuccess(100, 'Rostro registrado correctamente.');
        return;
      }

      // 5. Caso B: el SERVIDOR compara contra el rostro enrolado (el navegador ya no conoce ese descriptor)
      setStatusMessage('Verificando identidad…');
      const tServer = performance.now();
      const result = await api.verifyFace(liveDescriptor, snapshot, tipo);
      console.info(
        `⏱️ [BIOMETRÍA] descriptor facial: ${Math.round(tDescriptor)} ms · verificación en servidor: ${Math.round(performance.now() - tServer)} ms`
      );
      setSimilarityScore(result.similarity);

      if (result.isMatch) {
        finishSuccess(result.similarity, `Identidad verificada (${result.similarity}% de coincidencia)`);
      } else {
        // El servidor ya registró el intento en la auditoría de fraude
        setStep('fraud_mismatch');
        setStatusMessage(`El rostro NO coincide con ${worker.nombre} (${result.similarity}% coincidencia)`);
        stopCamera();
      }
    } catch (err: any) {
      console.error('Error al procesar biometría:', err);
      setErrorMessage(err.message || 'Ocurrió un error durante la verificación.');
      setStep('no_face');
      setStatusMessage('Ocurrió un error. Intente de nuevo.');
    }
  };

  // Siempre apunta a la versión más reciente del handler (evita closures obsoletas en el loop)
  const captureHandlerRef = useRef(handleCaptureAndValidate);
  captureHandlerRef.current = handleCaptureAndValidate;
  const registrarFalloRef = useRef(registrarFallo);
  registrarFalloRef.current = registrarFallo;

  // Prueba de vida con RETOS ALEATORIOS: se pide una secuencia de movimientos distinta cada vez (girar la cabeza,
  // sonreír, abrir la boca, parpadear dos veces). Un video grabado no sabe qué se va a pedir.
  useEffect(() => {
    if (!isOpen || !cameraReady || step !== 'ready' || fallo || blinkModuleState !== 'ready' || bloqueadoHasta > Date.now()) return;

    let cancelled = false;
    const ejecutor = new EjecutorRetos(secuencia);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let capturandoInicio = false;
    let ultimoEmit = 0;
    let ultimaClave = '';
    let frames = 0;
    let fps = 0;
    let fpsStart = Date.now();

    const loop = async () => {
      while (!cancelled) {
        const video = videoRef.current;
        if (!video || video.paused || video.readyState < 2) {
          await sleep(100);
          continue;
        }

        try {
          const r = eyeBlinkService.read(video);
          if (cancelled) return;
          const ahora = performance.now();
          const lectura =
            r && r.turn !== null ? { cerrado: r.closed, sonrisa: r.smile, boca: r.jaw, giro: r.turn } : null;
          const est = ejecutor.actualizar(lectura, ahora);

          // Se actualiza la pantalla solo cuando algo cambia (o cada ~120 ms para la barra de tiempo)
          const clave = `${est.fase}|${est.indice}|${est.esperandoReposo}|${est.parpadeos}|${lectura ? 1 : 0}`;
          if (clave !== ultimaClave || ahora - ultimoEmit > 120) {
            ultimaClave = clave;
            ultimoEmit = ahora;
            setRetoEstado(est);
          }

          frames += 1;
          const elapsed = (Date.now() - fpsStart) / 1000;
          if (elapsed >= 1) {
            fps = Math.round(frames / elapsed);
            frames = 0;
            fpsStart = Date.now();
          }
          setLivenessDebug(
            lectura
              ? `giro ${lectura.giro.toFixed(2)} · sonrisa ${lectura.sonrisa.toFixed(2)} · boca ${lectura.boca.toFixed(2)} · ojos ${lectura.cerrado.toFixed(2)} · ${fps} fps`
              : 'sin rostro detectado'
          );

          // Descriptor del INICIO de la prueba (rostro de frente y en reposo), para comprobar la continuidad al final
          if (est.fase === 'reto' && !descInicioRef.current && !capturandoInicio && lectura) {
            capturandoInicio = true;
            faceRecognitionService
              .detectFullFace(video)
              .then((d) => {
                if (d && !cancelled) descInicioRef.current = Array.from(d.descriptor);
              })
              .catch(() => {})
              .finally(() => {
                capturandoInicio = false;
              });
          }

          if (est.fase === 'fallo') {
            const motivo = est.motivo ?? 'tiempo';
            registrarFalloRef.current(motivo);
            setFallo(motivo);
            return;
          }
          if (est.fase === 'listo') {
            captureHandlerRef.current();
            return;
          }
        } catch (err) {
          console.warn('Error en prueba de vida:', err);
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    };

    loop();
    return () => {
      cancelled = true;
    };
  }, [isOpen, cameraReady, step, fallo, blinkModuleState, secuencia, bloqueadoHasta]);

  // ---- Textos de la pantalla ----
  const bloqueado = bloqueadoHasta > ahoraTick;
  const segBloqueo = Math.max(0, Math.ceil((bloqueadoHasta - ahoraTick) / 1000));

  const instruccion = (() => {
    if (bloqueado) return `Demasiados intentos fallidos. Espere ${segBloqueo} s para volver a intentar.`;
    if (blinkModuleState === 'loading') return 'Preparando la verificación de vida. La primera vez puede tardar un poco.';
    if (blinkModuleState === 'error') return 'No se pudo cargar la verificación de vida. Recargue la página e intente de nuevo.';
    if (fallo) return MENSAJE_FALLO[fallo];
    const e = retoEstado;
    if (!e || e.fase === 'calibrando') return 'Mire de frente a la cámara, con el rostro dentro del recuadro, y quédese quieto.';
    if (e.fase === 'reto' && e.esperandoReposo) return 'Quédese quieto y mire de frente…';
    if (e.fase === 'reto' && e.reto) return TEXTO_RETO[e.reto] + (e.reto === 'parpadear2' ? ` (${e.parpadeos}/2)` : '');
    if (e.fase === 'frontal') return 'Muy bien. Ahora mire de frente y quédese quieto.';
    if (e.fase === 'listo') return 'Verificando…';
    return 'Mire a la cámara.';
  })();

  if (!isOpen) return null;

  const showDebug = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

  // Color del mensaje de estado según el paso
  const statusTone =
    errorMessage || step === 'no_face' || step === 'fraud_mismatch' || fallo || bloqueado
      ? 'border-l-red-700 bg-red-50 text-red-900'
      : step === 'success'
      ? 'border-l-green-700 bg-green-50 text-green-900'
      : step === 'processing'
      ? 'border-l-brand-600 bg-brand-50 text-brand-900'
      : 'border-l-slate-400 bg-slate-50 text-slate-800';

  const closeModal = () => {
    stopCamera();
    onClose();
  };

  const retoActivo = retoEstado && retoEstado.fase === 'reto' && !retoEstado.esperandoReposo && !fallo ? retoEstado.reto : null;
  const porcentajeTiempo = retoEstado && retoActivo ? Math.max(0, Math.min(100, (retoEstado.restanteMs / 4500) * 100)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-3 sm:p-4">
      <div className="flex w-full max-w-md flex-col overflow-hidden border border-slate-300 bg-white shadow-xl">
        {/* Cabecera */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Reconocimiento facial · {ETIQUETA_TIPO[tipo]}</h3>
            <p className="text-sm text-slate-600">
              {worker.nombre} ({worker.codigo_empleado})
            </p>
          </div>
          <button
            type="button"
            onClick={closeModal}
            aria-label="Cerrar"
            className="p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Visor de cámara */}
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-900">
          {/* El video permanece siempre montado para evitar pantallas negras */}
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full scale-x-[-1] object-cover" />

          {/* Imagen congelada con marca de agua */}
          {capturedPhoto && <img src={capturedPhoto} alt="Rostro capturado" className="absolute inset-0 h-full w-full object-cover" />}

          {/* Guía de encuadre */}
          {step === 'ready' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className={`h-[78%] w-[52%] border-2 ${cameraReady ? 'border-white/90' : 'border-dashed border-white/50'}`} />
            </div>
          )}

          {/* Flechas de giro (la vista es como un espejo: la flecha apunta hacia donde debe girar) */}
          {retoActivo === 'giro_izq' && (
            <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 bg-brand-600 p-3 text-white shadow-lg">
              <ArrowLeft className="h-8 w-8" />
            </div>
          )}
          {retoActivo === 'giro_der' && (
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 bg-brand-600 p-3 text-white shadow-lg">
              <ArrowRight className="h-8 w-8" />
            </div>
          )}

          {/* Reto en curso: instrucción grande sobre la imagen */}
          {step === 'ready' && cameraReady && retoActivo && (
            <div className="pointer-events-none absolute inset-x-0 top-0 bg-brand-700/90 px-3 py-2 text-center text-white">
              <p className="text-xs opacity-80">
                Paso {(retoEstado?.indice ?? 0) + 1} de {retoEstado?.total}
              </p>
              <p className="text-lg font-semibold leading-tight">{instruccion}</p>
              <div className="mt-1.5 h-1 w-full bg-white/25">
                <div className="h-full bg-white transition-[width] duration-100" style={{ width: `${porcentajeTiempo}%` }} />
              </div>
            </div>
          )}

          {/* Verificando */}
          {step === 'processing' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/55 text-white">
              <RefreshCw className="h-8 w-8 animate-spin" />
              <span className="text-sm font-medium">Verificando identidad…</span>
            </div>
          )}

          {/* Resultado correcto */}
          {step === 'success' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-green-900/70 text-white">
              <CheckCircle2 className="h-14 w-14" />
              <span className="text-base font-semibold">Identidad verificada</span>
            </div>
          )}

          {/* El rostro no coincide */}
          {step === 'fraud_mismatch' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-900/75 text-white">
              <AlertTriangle className="h-14 w-14" />
              <span className="text-base font-semibold">No coincide</span>
            </div>
          )}

          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Estado y acciones */}
        <div className="space-y-3 p-4">
          <div className={`border-l-4 px-3 py-2.5 text-sm ${statusTone}`}>
            {step === 'processing' ? (
              <span className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 animate-spin" />
                {statusMessage}
              </span>
            ) : step === 'ready' && cameraReady ? (
              errorMessage || instruccion
            ) : (
              errorMessage || statusMessage
            )}
          </div>

          {/* Indicador de la prueba de vida */}
          {step === 'ready' && !fallo && !bloqueado && (
            <div
              className={`flex items-center justify-center gap-2 border px-3 py-2.5 text-sm font-medium ${
                !cameraReady ? 'border-slate-300 bg-slate-50 text-slate-500' : 'border-brand-200 bg-brand-50 text-brand-800'
              }`}
            >
              <Eye className="h-4 w-4" />
              <span>
                {!cameraReady
                  ? errorMessage
                    ? 'Cámara no disponible'
                    : 'Iniciando cámara…'
                  : blinkModuleState === 'loading'
                  ? 'Preparando verificación…'
                  : blinkModuleState === 'error'
                  ? 'Verificación no disponible'
                  : 'Siga las indicaciones en pantalla'}
              </span>
            </div>
          )}

          {step === 'ready' && (fallo || bloqueado) && (
            <button type="button" onClick={resumeCamera} disabled={bloqueado} className="btn-primary w-full disabled:opacity-50">
              <RotateCcw className="h-4 w-4" />
              {bloqueado ? `Espere ${segBloqueo} s` : 'Reintentar con otra secuencia'}
            </button>
          )}

          {step === 'no_face' && (
            <button type="button" onClick={resumeCamera} className="btn-primary w-full">
              <RotateCcw className="h-4 w-4" />
              Volver a intentar
            </button>
          )}

          {step === 'fraud_mismatch' && (
            <div className="space-y-2">
              <p className="text-sm text-red-800">Su rostro no coincide con el perfil asignado a este trabajador.</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={startCamera} className="btn-primary">
                  Reintentar
                </button>
                <button type="button" onClick={closeModal} className="btn-secondary">
                  Cerrar
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-sm text-slate-600">
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 ${cameraReady ? 'bg-green-600' : 'bg-slate-400'}`} />
              {cameraReady ? 'Cámara lista' : 'Preparando'}
            </span>
            <span className="tabular-nums">{similarityScore > 0 ? `Similitud: ${similarityScore}%` : 'Verificación 1:1'}</span>
          </div>

          {showDebug && step === 'ready' && cameraReady && (
            <p className="text-center text-xs tabular-nums text-slate-400">{livenessDebug}</p>
          )}
        </div>
      </div>
    </div>
  );
};
