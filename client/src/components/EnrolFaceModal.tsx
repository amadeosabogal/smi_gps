import React, { useState, useRef } from 'react';
import { Camera, CheckCircle, AlertCircle, X, RefreshCw, Upload, ShieldCheck } from 'lucide-react';
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
      setErrorMsg('No se pudo acceder a la cámara. Puedes subir una foto.');
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
        throw new Error('No se detectó ningún rostro claro en la imagen. Asegúrate de tener buena luz y mirar de frente.');
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
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-4 font-sans animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 max-w-sm w-full rounded-3xl overflow-hidden shadow-2xl flex flex-col">
        {/* Cabecera */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between text-white bg-slate-950/70">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-extrabold text-sm text-white">Enrolar Rostro Oficial</h3>
              <p className="text-[11px] text-slate-400">
                {worker.nombre} ({worker.codigo_empleado})
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Visor o Previsualización */}
        <div className="relative bg-black w-full h-72 flex items-center justify-center overflow-hidden">
          {photoPreview ? (
            <img src={photoPreview} alt="Foto oficial" className="w-full h-full object-cover" />
          ) : mode === 'camera' ? (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-44 h-56 border-2 border-dashed border-white/70 rounded-[45%]"></div>
              </div>
            </>
          ) : (
            <div className="p-6 text-center text-slate-400">
              <Upload className="w-10 h-10 mx-auto mb-2 text-slate-500" />
              <p className="text-xs">Selecciona una fotografía clara del rostro del trabajador</p>
            </div>
          )}

          <canvas ref={canvasRef} className="hidden" />
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
        </div>

        {/* Feedback Messages */}
        {errorMsg && (
          <div className="p-2.5 bg-rose-950/80 border-t border-rose-500/40 text-rose-300 text-xs flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="p-2.5 bg-emerald-950/80 border-t border-emerald-500/40 text-emerald-300 text-xs flex items-center space-x-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Botones de Acción */}
        <div className="p-4 bg-slate-950 flex flex-col space-y-2.5">
          {photoPreview ? (
            <div className="flex space-x-2">
              <button
                type="button"
                onClick={() => {
                  setPhotoPreview(null);
                  setErrorMsg(null);
                  if (mode === 'camera') startCamera();
                }}
                disabled={isProcessing}
                className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl"
              >
                Repetir Foto
              </button>
              <button
                type="button"
                onClick={handleSaveEnrolment}
                disabled={isProcessing}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl flex items-center justify-center space-x-1.5 shadow"
              >
                {isProcessing ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    <span>Guardar y Enrolar</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="flex space-x-2">
              {mode === 'camera' ? (
                <>
                  <button
                    type="button"
                    onClick={handleSnap}
                    className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl flex items-center justify-center space-x-1.5 shadow"
                  >
                    <Camera className="w-4 h-4" />
                    <span>Capturar Rostro</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stopCamera();
                      setMode('upload');
                      fileInputRef.current?.click();
                    }}
                    className="px-3 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl"
                    title="Subir archivo"
                  >
                    <Upload className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl flex items-center justify-center space-x-1.5 shadow"
                >
                  <Upload className="w-4 h-4" />
                  <span>Seleccionar Foto</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

