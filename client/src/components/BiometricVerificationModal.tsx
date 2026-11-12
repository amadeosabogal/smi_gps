import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, X, ScanFace, RotateCcw, Eye } from 'lucide-react';
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
const LIVENESS_PROMPT = 'Mira a la cámara y parpadea una vez para verificar que eres tú';

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
    setStatusMessage('Iniciando cámara frontal...');
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
      setErrorMessage(err.message || 'No se pudo acceder a la cámara frontal.');
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
    setStatusMessage('Analizando rostro en tiempo real...');

    // Permitir un microciclo de renderizado para mostrar la congelación y el loader
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));

    try {
      // 2. Extraer descriptor biométrico DIRECTAMENTE de la textura de video activa (máxima velocidad WebGL)
      const tStart = performance.now();
      const detection = await faceRecognitionService.detectFullFace(video);
      const tDescriptor = performance.now() - tStart;

      if (!detection) {
        setStep('no_face');
        setStatusMessage('No se detectó un rostro claro en la captura.');
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
        setStatusMessage('Enrolando rostro por primera vez...');
        await api.enrolSelf(liveDescriptor, snapshot, tipo);
        finishSuccess(100, `¡Rostro enrolado con éxito! Bienvenido ${worker.nombre.split(' ')[0]}.`);
        return;
      }

      // 5. Caso B: el SERVIDOR compara contra el rostro enrolado (el navegador ya no conoce ese descriptor)
      setStatusMessage('Verificando identidad...');
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
      setErrorMessage(err.message || 'Error durante la verificación.');
      setStep('no_face');
      setStatusMessage('Ocurrió un error. Intenta capturar nuevamente.');
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
      ? 'Preparando verificación de vida… (la primera vez puede tardar un poco)'
      : blinkModuleState === 'error'
      ? 'No se pudo cargar la verificación de vida. Recarga la página e intenta de nuevo.'
      : livenessTimedOut
      ? 'No se detectó parpadeo. Presiona "Reintentar" y parpadea mirando a la cámara.'
      : blinkPhase === 'no_face'
      ? 'No se ve tu rostro. Colócalo dentro del círculo.'
      : blinkPhase === 'eyes_closed'
      ? 'Parpadeo detectado…'
      : blinkPhase === 'waiting_blink'
      ? 'Rostro detectado. Parpadea ahora 👁️'
      : LIVENESS_PROMPT;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex items-center justify-center p-4 font-sans animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 max-w-sm w-full rounded-3xl overflow-hidden shadow-2xl flex flex-col">
        {/* Cabecera */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between text-white bg-slate-950/80">
          <div className="flex items-center space-x-2.5">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-md transition-colors ${
                step === 'success'
                  ? 'bg-emerald-600'
                  : step === 'fraud_mismatch'
                  ? 'bg-rose-600'
                  : 'bg-blue-600'
              }`}
            >
              <ScanFace className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-extrabold text-sm text-white">Reconocimiento Facial</h3>
              <p className="text-[11px] text-slate-400 capitalize">
                {worker.nombre.split(' ')[0]} ({worker.codigo_empleado})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Visor de Cámara con Guía Biométrica */}
        <div className="relative bg-slate-950 w-full h-84 flex items-center justify-center overflow-hidden">
          {/* El elemento de video permanece SIEMPRE montado para evitar cualquier pantalla negra */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover scale-x-[-1]"
          />

          {/* Imagen congelada con marca de agua (aparece suavemente encima del video cuando está lista) */}
          {capturedPhoto && (
            <img
              src={capturedPhoto}
              alt="Rostro capturado"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}

          {/* Anillo de enfoque de rostro en modo listo */}
          {step === 'ready' && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
              <div
                className={`relative w-56 h-64 rounded-[45%] border-2 transition-all duration-300 flex items-center justify-center ${
                  cameraReady
                    ? 'border-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.35)]'
                    : 'border-blue-400 border-dashed animate-pulse'
                }`}
              >
                <div className="absolute w-full h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-bounce opacity-70" />
              </div>
            </div>
          )}

          {/* Animación de escaneo biométrico durante el análisis */}
          {step === 'processing' && (
            <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px] flex flex-col items-center justify-center text-white space-y-2">
              <div className="relative w-52 h-60 rounded-[45%] border-2 border-cyan-400 shadow-[0_0_25px_rgba(34,211,238,0.5)] flex items-center justify-center">
                <div className="absolute w-full h-1 bg-cyan-400 animate-pulse shadow-[0_0_15px_#22d3ee]" />
              </div>
              <div className="flex items-center space-x-1.5 bg-slate-900/90 border border-slate-700/80 px-3 py-1 rounded-full shadow-lg">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                <span className="text-[11px] font-bold text-cyan-200">Verificando rostro...</span>
              </div>
            </div>
          )}

          {/* Icono de éxito */}
          {step === 'success' && (
            <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-[1px] flex items-center justify-center">
              <div className="w-20 h-20 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-2xl animate-scale-up">
                <CheckCircle2 className="w-12 h-12" />
              </div>
            </div>
          )}

          {/* Icono de mismatch/fraude */}
          {step === 'fraud_mismatch' && (
            <div className="absolute inset-0 bg-rose-950/60 backdrop-blur-[1px] flex items-center justify-center">
              <div className="w-20 h-20 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-2xl animate-scale-up">
                <AlertTriangle className="w-12 h-12" />
              </div>
            </div>
          )}

          {/* Canvas oculto para procesar foto */}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Barra de Estado y Botones de Acción */}
        <div className="p-4 bg-slate-950 flex flex-col space-y-3">
          <div
            className={`p-3 rounded-2xl text-xs font-bold text-center border transition-all ${
              errorMessage || step === 'no_face'
                ? 'bg-rose-950/80 border-rose-500/60 text-rose-300'
                : step === 'success'
                ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                : step === 'fraud_mismatch'
                ? 'bg-rose-950/80 border-rose-500/60 text-rose-300'
                : step === 'processing'
                ? 'bg-blue-950/80 border-blue-500/60 text-blue-300'
                : 'bg-slate-900 border-slate-800 text-slate-300'
            }`}
          >
            {step === 'processing' ? (
              <div className="flex items-center justify-center space-x-2">
                <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
                <span>{statusMessage}</span>
              </div>
            ) : (
              <span>{errorMessage || (step === 'ready' && cameraReady ? livenessHint : statusMessage)}</span>
            )}
          </div>

          {/* Prueba de vida: la captura es automática tras el parpadeo (sin botón para saltarla) */}
          {step === 'ready' && (
            <div
              className={`w-full py-3.5 px-4 rounded-2xl text-xs font-extrabold flex items-center justify-center space-x-2 border transition-colors ${
                !cameraReady
                  ? 'bg-slate-800 text-slate-500 border-slate-700'
                  : livenessTimedOut
                  ? 'bg-rose-950/80 text-rose-300 border-rose-500/60'
                  : blinkPhase === 'eyes_closed'
                  ? 'bg-emerald-600 text-white border-emerald-400'
                  : 'bg-slate-900 text-emerald-300 border-emerald-500/40'
              }`}
            >
              <Eye className={`w-4 h-4 ${cameraReady && !livenessTimedOut ? 'animate-pulse' : ''}`} />
              <span>
                {!cameraReady
                  ? errorMessage
                    ? 'Cámara no disponible'
                    : 'Iniciando cámara...'
                  : blinkModuleState === 'loading'
                  ? 'Preparando verificación...'
                  : blinkModuleState === 'error'
                  ? 'Verificación no disponible'
                  : livenessTimedOut
                  ? 'Tiempo agotado'
                  : 'Esperando parpadeo...'}
              </span>
            </div>
          )}

          {/* Reintentar tras tiempo agotado sin parpadeo */}
          {step === 'ready' && livenessTimedOut && (
            <button
              type="button"
              onClick={resumeCamera}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer shadow-lg active:scale-95"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Reintentar</span>
            </button>
          )}

          {/* En caso de no detectar rostro claro */}
          {step === 'no_face' && (
            <button
              type="button"
              onClick={resumeCamera}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer shadow-lg active:scale-95"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Tomar otra foto</span>
            </button>
          )}

          {/* En caso de desajuste de identidad */}
          {step === 'fraud_mismatch' && (
            <div className="space-y-2">
              <p className="text-[11px] text-rose-400 text-center font-medium">
                ⛔ Tu rostro no coincide con el perfil asignado a este trabajador.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={startCamera}
                  className="py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl transition cursor-pointer active:scale-95"
                >
                  Reintentar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    stopCamera();
                    onClose();
                  }}
                  className="py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition cursor-pointer active:scale-95"
                >
                  Cerrar
                </button>
              </div>
            </div>
          )}

          {/* Indicador de estado */}
          <div className="flex items-center justify-between text-[11px] text-slate-400 px-1 pt-1">
            <span className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  cameraReady ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                }`}
              />
              <span>{cameraReady ? 'Cámara lista' : 'Preparando'}</span>
            </span>
            <span className="font-mono text-[10px] text-slate-500">
              {similarityScore > 0 ? `Similitud: ${similarityScore}%` : 'Biometría 1:1'}
            </span>
          </div>
          {/* Diagnóstico de la prueba de vida (valores en vivo) */}
          <div className="text-center font-mono text-[10px] text-slate-500 min-h-[14px]">
            {step === 'ready' && cameraReady ? livenessDebug : ''}
          </div>
        </div>
      </div>
    </div>
  );
};
