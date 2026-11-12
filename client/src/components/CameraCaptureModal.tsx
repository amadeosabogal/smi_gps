import React, { useState, useRef, useEffect } from 'react';
import { Camera, RefreshCw, CheckCircle, X, AlertCircle, Upload, SwitchCamera } from 'lucide-react';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  tipo: 'entrada' | 'salida';
  onPhotoCaptured: (base64Photo: string) => void;
  workerName?: string;
}

export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({
  isOpen,
  onClose,
  tipo,
  onPhotoCaptured,
  workerName,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // Por defecto cámara trasera (entorno de trabajo)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  // Detener la cámara de forma segura
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  // Ciclo de vida controlado: Inicia SOLO cuando se abre el modal o se conmuta la cámara
  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setCapturedPhoto(null);
      return;
    }

    setCapturedPhoto(null);
    setCameraError(null);

    let isMounted = true;

    async function initCamera() {
      // Detener stream previo si existía
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Navegador sin soporte de cámara directa');
        }

        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        };

        const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (!isMounted) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          videoRef.current.play().catch(() => {});
        }
      } catch (err: any) {
        console.warn('Error accediendo a cámara:', err);
        if (isMounted) {
          setCameraError(
            'No se pudo activar la vista en vivo de la cámara. Puedes pulsar el botón inferior para tomar la foto con tu cámara o subirla.'
          );
        }
      }
    }

    initCamera();

    return () => {
      isMounted = false;
      stopCamera();
    };
  }, [isOpen, facingMode]);

  // Capturar fotograma desde el video
  const handleSnap = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Si el usuario eligió cámara frontal, aplicar efecto espejo
      if (facingMode === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Marca de agua de evidencia con fecha y hora
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(0, canvas.height - 36, canvas.width, 36);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 13px Archivo, Arial, sans-serif';
      const timestamp = `SMI EVIDENCIA: ${new Date().toLocaleString()} - ${tipo.toUpperCase()}`;
      ctx.fillText(timestamp, 14, canvas.height - 13);

      const base64 = canvas.toDataURL('image/jpeg', 0.82);
      setCapturedPhoto(base64);
      stopCamera();
    }
  };

  // Carga alternativa desde archivo o cámara del sistema
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setCapturedPhoto(event.target.result as string);
          stopCamera();
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // Repetir fotografía
  const handleRetake = () => {
    setCapturedPhoto(null);
    setCameraError(null);
    // Reiniciar cámara
    setFacingMode((prev) => prev);
  };

  // Confirmar y registrar
  const handleConfirm = () => {
    if (!capturedPhoto) return;
    onPhotoCaptured(capturedPhoto);
    stopCamera();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4 font-sans animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 max-w-sm w-full rounded-3xl overflow-hidden shadow-2xl flex flex-col">
        {/* Cabecera */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between text-white bg-slate-950/70">
          <div className="flex items-center space-x-2.5">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                tipo === 'entrada' ? 'bg-emerald-600' : 'bg-rose-600'
              }`}
            >
              <Camera className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-extrabold text-sm text-white">
                Evidencia de {tipo === 'entrada' ? 'Entrada' : 'Salida'}
              </h3>
              <p className="text-[11px] text-slate-400">
                {workerName ? `${workerName.split(' ')[0]} • ` : ''}Foto del Entorno de Trabajo
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

        {/* Visor de Cámara o Previsualización */}
        <div className="relative bg-black w-full h-80 flex items-center justify-center overflow-hidden">
          {capturedPhoto ? (
            <img
              src={capturedPhoto}
              alt="Evidencia del entorno capturada"
              className="w-full h-full object-cover"
            />
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-cover ${
                  facingMode === 'user' ? 'scale-x-[-1]' : ''
                }`}
              />

              {/* Marco visor de entorno de trabajo */}
              <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-between p-6">
                <div className="w-full flex justify-between">
                  <div className="w-6 h-6 border-t-2 border-l-2 border-white/80"></div>
                  <div className="w-6 h-6 border-t-2 border-r-2 border-white/80"></div>
                </div>
                <div className="text-center text-white/95 text-[11px] font-bold bg-slate-950/70 border border-slate-700/80 px-3.5 py-1.5 rounded-full backdrop-blur-sm shadow-md">
                  📷 Enfoca tu estación o área de trabajo
                </div>
                <div className="w-full flex justify-between">
                  <div className="w-6 h-6 border-b-2 border-l-2 border-white/80"></div>
                  <div className="w-6 h-6 border-b-2 border-r-2 border-white/80"></div>
                </div>
              </div>
            </>
          )}

          {/* Mensaje si la cámara en vivo no arranca */}
          {cameraError && !capturedPhoto && (
            <div className="absolute inset-0 bg-slate-900/95 p-6 flex flex-col items-center justify-center text-center">
              <AlertCircle className="w-10 h-10 text-amber-400 mb-2" />
              <p className="text-xs text-slate-300 mb-4">{cameraError}</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center space-x-1.5 shadow cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>Tomar / Adjuntar Foto</span>
              </button>
            </div>
          )}

          {/* Input oculto para cámara nativa del celular */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileInput}
            className="hidden"
          />
        </div>

        {/* Canvas oculto */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Controles de Acción */}
        <div className="p-4 bg-slate-950 flex flex-col space-y-3">
          {capturedPhoto ? (
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={handleRetake}
                className="flex-1 py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Repetir Foto</span>
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className={`flex-1 py-3 px-4 rounded-xl font-extrabold text-xs text-white flex items-center justify-center space-x-1.5 transition shadow-lg cursor-pointer ${
                  tipo === 'entrada'
                    ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/30'
                    : 'bg-rose-600 hover:bg-rose-700 shadow-rose-600/30'
                }`}
              >
                <CheckCircle className="w-4 h-4" />
                <span>Confirmar {tipo === 'entrada' ? 'Entrada' : 'Salida'}</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              {/* Conmutar cámara trasera / frontal */}
              <button
                type="button"
                onClick={() =>
                  setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
                }
                className="p-3 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-2xl transition cursor-pointer flex items-center gap-1 text-[11px]"
                title="Girar cámara"
              >
                <SwitchCamera className="w-5 h-5 text-blue-400" />
                <span className="hidden sm:inline">Girar</span>
              </button>

              {/* Botón Disparador */}
              <button
                type="button"
                onClick={handleSnap}
                className="w-16 h-16 rounded-full border-4 border-white bg-blue-600 hover:bg-blue-500 shadow-xl flex items-center justify-center transition transform active:scale-95 cursor-pointer"
                title="Tomar Foto"
              >
                <div className="w-12 h-12 rounded-full border-2 border-white/80 bg-white"></div>
              </button>

              {/* Botón alternativo de archivo / cámara nativa */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-3 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-2xl transition cursor-pointer flex items-center gap-1 text-[11px]"
                title="Subir desde galería o cámara"
              >
                <Upload className="w-5 h-5 text-emerald-400" />
                <span className="hidden sm:inline">Galería</span>
              </button>
            </div>
          )}

          <p className="text-[10px] text-slate-500 text-center">
            📸 Evidencia fotográfica de tu entorno en la estación para validar tu jornada.
          </p>
        </div>
      </div>
    </div>
  );
};
