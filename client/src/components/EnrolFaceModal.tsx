import React, { useState, useRef } from 'react';
import { Camera, CheckCircle, AlertCircle, X, RefreshCw, Upload } from 'lucide-react';
import { faceRecognitionService } from '../services/faceRecognition';
import { api } from '../services/api';
import type { Usuario } from '../types';

interface EnrolFaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  worker: Usuario;
  onEnrolSuccess: () => void;
}

export const EnrolFaceModal: React.FC<EnrolFaceModalProps> = ({
  isOpen,
  onClose,
  worker,
  onEnrolSuccess,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [mode, setMode] = useState<'camera' | 'upload'>('camera');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const startCamera = async () => {
    stopCamera();
    setErrorMsg(null);
    setPhotoPreview(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    } catch {
      setErrorMsg('No se pudo acceder a la cámara. Puede subir una fotografía.');
      setMode('upload');
    }
  };

  // Abrir cámara al montar
  React.useEffect(() => {
    if (isOpen) {
      setPhotoPreview(null);
      setErrorMsg(null);
      setSuccessMsg(null);
      if (mode === 'camera') {
        startCamera();
      }
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [isOpen, mode]);

  // Tomar foto con la cámara
  const handleSnap = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.9);
    setPhotoPreview(base64);
    stopCamera();
  };

  // Carga desde archivo
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setPhotoPreview(event.target.result as string);
          stopCamera();
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // Procesar detección y guardar descriptor en SQL Server
  const handleSaveEnrolment = async () => {
    if (!photoPreview) return;
    setIsProcessing(true);
    setErrorMsg(null);

    try {
      // 1. Cargar la imagen en un elemento HTML para que face-api la analice
      const img = new Image();
      img.src = photoPreview;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      // 2. Extraer descriptor facial
      const detection = await faceRecognitionService.detectFace(img);
      if (!detection) {
        throw new Error('No se detectó ningún rostro claro en la imagen. Asegúrese de tener buena luz y mirar de frente.');
      }

      const descriptor = Array.from(detection.descriptor);

      // 3. Guardar en SQL Server
      await api.enrolFace(worker.id, descriptor, photoPreview);
      setSuccessMsg(`¡Rostro maestro de ${worker.nombre} enrolado con éxito!`);

      setTimeout(() => {
        onEnrolSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al procesar el rostro');
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-3 sm:p-4">
      <div className="flex w-full max-w-md flex-col overflow-hidden border border-slate-300 bg-white shadow-xl">
        {/* Cabecera */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Registrar rostro oficial</h3>
            <p className="text-sm text-slate-600">
              {worker.nombre} ({worker.codigo_empleado})
            </p>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            aria-label="Cerrar"
            className="p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Visor o previsualización */}
        <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-slate-900">
          {photoPreview ? (
            <img src={photoPreview} alt="Foto oficial" className="h-full w-full object-cover" />
          ) : mode === 'camera' ? (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="h-full w-full scale-x-[-1] object-cover" />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-[78%] w-[52%] border-2 border-white/90" />
              </div>
            </>
          ) : (
            <div className="p-6 text-center text-slate-300">
              <Upload className="mx-auto mb-2 h-10 w-10 text-slate-400" />
              <p className="text-sm">Seleccione una fotografía clara del rostro del trabajador</p>
            </div>
          )}

          <canvas ref={canvasRef} className="hidden" />
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
        </div>

        {/* Mensajes */}
        {errorMsg && (
          <div className="flex items-center gap-2 border-l-4 border-l-red-700 bg-red-50 px-4 py-2.5 text-sm text-red-900">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="flex items-center gap-2 border-l-4 border-l-green-700 bg-green-50 px-4 py-2.5 text-sm text-green-900">
            <CheckCircle className="h-4 w-4 flex-shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Acciones */}
        <div className="p-4">
          {photoPreview ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setPhotoPreview(null);
                  setErrorMsg(null);
                  if (mode === 'camera') startCamera();
                }}
                disabled={isProcessing}
                className="btn-secondary flex-1"
              >
                Repetir foto
              </button>
              <button type="button" onClick={handleSaveEnrolment} disabled={isProcessing} className="btn-primary flex-1">
                {isProcessing ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4" />
                    Guardar y registrar
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              {mode === 'camera' ? (
                <>
                  <button type="button" onClick={handleSnap} className="btn-primary flex-1">
                    <Camera className="h-4 w-4" />
                    Capturar rostro
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopCamera();
                      setMode('upload');
                      fileInputRef.current?.click();
                    }}
                    className="btn-secondary"
                    title="Subir archivo"
                    aria-label="Subir archivo"
                  >
                    <Upload className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-primary w-full">
                  <Upload className="h-4 w-4" />
                  Seleccionar foto
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
