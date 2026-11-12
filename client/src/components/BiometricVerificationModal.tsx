import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, X, RotateCcw, Eye } from 'lucide-react';
import { faceRecognitionService } from '../services/faceRecognition';
import { BlinkDetector, type BlinkPhase } from '../services/blinkDetector';
import { eyeBlinkService } from '../services/eyeBlink';
import { api } from '../services/api';
import type { Usuario } from '../types';

interface BiometricVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  tipo: 'entrada' | 'salida';
  worker: Usuario;
  onVerificationSuccess: (result: {
    photoBase64: string;
    similarity: number;
    isVerified: boolean;
  }) => void;
}

type StepState = 'ready' | 'processing' | 'success' | 'fraud_mismatch' | 'no_face';

// Tiempo máximo esperando el parpadeo antes de pedir reintentar (ms)
const LIVENESS_TIMEOUT_MS = 20000;
const LIVENESS_PROMPT = 'Mire a la cámara y parpadee una vez para verificar su identidad.';

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
  const [statusMessage, setStatusMessage] = useState<string>(LIVENESS_PROMPT);
  const [blinkPhase, setBlinkPhase] = useState<BlinkPhase | 'no_face'>('calibrating');
  const [livenessTimedOut, setLivenessTimedOut] = useState<boolean>(false);
  const [livenessDebug, setLivenessDebug] = useState<string>('');
  const [blinkModuleState, setBlinkModuleState] = useState<'loading' | 'ready' | 'error'>(
    eyeBlinkService.isReady() ? 'ready' : 'loading'
  );
  const [similarityScore, setSimilarityScore] = useState<number>(0);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState<boolean>(false);

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

  // Reanudar cámara en vivo (descongelar) de forma instantánea
  const resumeCamera = useCallback(() => {
    setCapturedPhoto(null);
    setStep('ready');
    setErrorMessage(null);
    setLivenessTimedOut(false);
    setBlinkPhase('calibrating');
    setStatusMessage(LIVENESS_PROMPT);

    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, []);

  // Iniciar cámara frontal
  const startCamera = useCallback(async () => {
    setCameraReady(false);
    setCapturedPhoto(null);
    setLivenessTimedOut(false);
    setBlinkPhase('calibrating');
    setStep('ready');
    setStatusMessage('Iniciando cámara frontal…');
    setErrorMessage(null);

    // Si el stream ya existe y sigue activo, simplemente reactivar
    if (streamRef.current && streamRef.current.active && videoRef.current) {
      try {
        await videoRef.current.play();
        setCameraReady(true);
        setStatusMessage(LIVENESS_PROMPT);
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
          setStatusMessage(LIVENESS_PROMPT);
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
  }, []);

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

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

      // 3. Generar snapshot fotográfico en memoria con marca de agua
      const snapshot = captureSnapshot();
      if (!snapshot) {
        setErrorMessage('No se pudo generar la evidencia fotográfica.');
        setStep('no_face');
        return;
      }
      setCapturedPhoto(snapshot);

      const liveDescriptor = Array.from(detection.descriptor);

      const finishSuccess = (similarity: number, message: string) => {
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

  // Prueba de vida: el usuario debe parpadear. Al detectarlo se dispara la captura y validación.
  useEffect(() => {
    if (!isOpen || !cameraReady || step !== 'ready' || livenessTimedOut || blinkModuleState !== 'ready') return;

    let cancelled = false;
    // Se alimenta con "apertura" = 1 - cierre (blendshape): ~0.9 abierto, <0.5 cerrado
    const detector = new BlinkDetector({
      closedRatio: 0.7,
      reopenRatio: 0.85,
      minValidOpenEAR: 0.5,
    });
    const startedAt = Date.now();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let frames = 0;
    let fps = 0;
    let fpsStart = Date.now();

    const loop = async () => {
      while (!cancelled) {
        if (Date.now() - startedAt > LIVENESS_TIMEOUT_MS) {
          setLivenessTimedOut(true);
          return;
        }

        const video = videoRef.current;
        if (!video || video.paused || video.readyState < 2) {
          await sleep(100);
          continue;
        }

        try {
          const reading = eyeBlinkService.read(video);
          if (cancelled) return;

          if (!reading) {
            detector.reset(); // sin rostro no se acumula progreso
            setBlinkPhase('no_face');
            setLivenessDebug('sin rostro detectado');
          } else {
            const phase = detector.update(1 - reading.closed);
            setBlinkPhase(phase);
            frames += 1;
            const elapsed = (Date.now() - fpsStart) / 1000;
            if (elapsed >= 1) {
              fps = Math.round(frames / elapsed);
              frames = 0;
              fpsStart = Date.now();
            }
            setLivenessDebug(
              `ojos cerrados ${reading.closed.toFixed(2)} · cierre>${(1 - detector.closedThreshold).toFixed(2)} · ${fps} fps`
            );
            if (phase === 'blinked') {
              captureHandlerRef.current();
              return;
            }
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
  }, [isOpen, cameraReady, step, livenessTimedOut, blinkModuleState]);

  const livenessHint =
    blinkModuleState === 'loading'
      ? 'Preparando la verificación de vida. La primera vez puede tardar un poco.'
      : blinkModuleState === 'error'
      ? 'No se pudo cargar la verificación de vida. Recargue la página e intente de nuevo.'
      : livenessTimedOut
      ? 'No se detectó el parpadeo. Presione "Reintentar" y parpadee mirando a la cámara.'
      : blinkPhase === 'no_face'
      ? 'No se ve su rostro. Colóquelo dentro del recuadro.'
      : blinkPhase === 'eyes_closed'
      ? 'Parpadeo detectado…'
      : blinkPhase === 'waiting_blink'
      ? 'Rostro detectado. Parpadee ahora.'
      : LIVENESS_PROMPT;

  if (!isOpen) return null;

  const showDebug = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

  // Color del mensaje de estado según el paso
  const statusTone =
    errorMessage || step === 'no_face' || step === 'fraud_mismatch'
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-3 sm:p-4">
      <div className="flex w-full max-w-md flex-col overflow-hidden border border-slate-300 bg-white shadow-xl">
        {/* Cabecera */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Reconocimiento facial · {tipo === 'entrada' ? 'Entrada' : 'Salida'}
            </h3>
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
            ) : (
              errorMessage || (step === 'ready' && cameraReady ? livenessHint : statusMessage)
            )}
          </div>

          {/* Prueba de vida: la captura es automática tras el parpadeo */}
          {step === 'ready' && (
            <div
              className={`flex items-center justify-center gap-2 border px-3 py-2.5 text-sm font-medium ${
                !cameraReady
                  ? 'border-slate-300 bg-slate-50 text-slate-500'
                  : livenessTimedOut
                  ? 'border-red-300 bg-red-50 text-red-800'
                  : blinkPhase === 'eyes_closed'
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-brand-200 bg-brand-50 text-brand-800'
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
                  : livenessTimedOut
                  ? 'Tiempo agotado'
                  : 'Esperando parpadeo…'}
              </span>
            </div>
          )}

          {step === 'ready' && livenessTimedOut && (
            <button type="button" onClick={resumeCamera} className="btn-primary w-full">
              <RotateCcw className="h-4 w-4" />
              Reintentar
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
