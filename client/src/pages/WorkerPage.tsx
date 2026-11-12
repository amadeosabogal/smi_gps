import React, { useState, useEffect, useCallback } from 'react';
import { api, auth } from '../services/api';
import { socket, connectSocket, disconnectSocket } from '../services/socket';
import { geolocationService, type CoordsData } from '../services/geolocation';
import type { Usuario, EstacionTrabajo } from '../types';
import {
  MapPin,
  ShieldCheck,
  AlertTriangle,
  Navigation,
  Compass,
  RefreshCw,
  Lock,
  ScanFace,
} from 'lucide-react';
import { BiometricVerificationModal } from '../components/BiometricVerificationModal';
import { faceRecognitionService } from '../services/faceRecognition';

export const WorkerPage: React.FC = () => {
  const [workers, setWorkers] = useState<Usuario[]>([]);
  const [workstations, setWorkstations] = useState<EstacionTrabajo[]>([]);
  const [selectedUser, setSelectedUser] = useState<Usuario | null>(null);

  // Authentication by PIN
  const [pinInput, setPinInput] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => Boolean(auth.getToken()));
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  // Shift & tracking state
  const [isActiveShift, setIsActiveShift] = useState<boolean>(false);
  const [shiftSeconds, setShiftSeconds] = useState<number>(0);

  // Modal de Cámara de Evidencia Obligatoria
  const [isCameraOpen, setIsCameraOpen] = useState<boolean>(false);
  const [cameraTipo, setCameraTipo] = useState<'entrada' | 'salida'>('entrada');

  // Estado de permisos y ubicación GPS del Celular
  const [gpsPermissionStatus, setGpsPermissionStatus] = useState<'granted' | 'prompt' | 'denied'>('prompt');
  const [gpsErrorMsg, setGpsErrorMsg] = useState<string | null>(null);

  // Geolocation state
  const [currentCoords, setCurrentCoords] = useState<CoordsData | null>(null);
  const [detectedStation, setDetectedStation] = useState<EstacionTrabajo | null>(null);
  const [isInsideStation, setIsInsideStation] = useState<boolean>(false);
  const [distanceToNearest, setDistanceToNearest] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(socket.connected);

  // Carga inicial: lista pública de nombres para el ingreso y, si hay sesión, el perfil y las estaciones
  const loadData = useCallback(async () => {
    try {
      if (auth.getToken()) {
        try {
          const [me, stationsData] = await Promise.all([api.getMe(), api.getWorkstations()]);
          setSelectedUser(me);
          setWorkers([me]);
          setWorkstations(stationsData);
          setIsAuthenticated(true);
          connectSocket();
          return;
        } catch {
          // Sesión vencida o inválida: volver a la pantalla de ingreso
          api.logout();
          setIsAuthenticated(false);
        }
      }

      const publicWorkers = await api.getPublicWorkers();
      const asUsers: Usuario[] = publicWorkers.map((w) => ({ ...w, correo: '', rol: 'trabajador', activo: true }));
      setWorkers(asUsers);
      if (asUsers.length > 0) setSelectedUser(asUsers[0]);
    } catch (err) {
      console.error('Error cargando datos del trabajador:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Pre-cargar modelos de reconocimiento facial en segundo plano para máxima velocidad en móvil
    faceRecognitionService.loadModels();

    const onConnect = () => setIsSocketConnected(true);
    const onDisconnect = () => setIsSocketConnected(false);
    const onUnauthorized = () => {
      geolocationService.stopTracking();
      disconnectSocket();
      setIsAuthenticated(false);
      setIsActiveShift(false);
      loadData();
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    window.addEventListener('smi:unauthorized', onUnauthorized);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      window.removeEventListener('smi:unauthorized', onUnauthorized);
    };
  }, [loadData]);

  // Check worker's current shift status in SQL Server
  const checkShiftStatus = useCallback(async () => {
    if (!selectedUser) return;
    try {
      const workerInfo = await api.getMyShift();

      if (workerInfo && workerInfo.estado_asistencia === 'activo') {
        setIsActiveShift(true);

        if (workerInfo.hora_ingreso) {
          const checkInDate = new Date(workerInfo.hora_ingreso).getTime();
          const now = Date.now();
          setShiftSeconds(Math.max(0, Math.floor((now - checkInDate) / 1000)));
        }

        if (workerInfo.latitud && workerInfo.longitud) {
          setCurrentCoords({
            latitude: workerInfo.latitud,
            longitude: workerInfo.longitud,
            accuracy: workerInfo.precision || 10,
            timestamp: Date.now(),
          });
        }

        setIsInsideStation(Boolean(workerInfo.dentro_de_estacion));
        if (workerInfo.estacion_id) {
          const st = workstations.find((w) => w.id === workerInfo.estacion_id);
          if (st) setDetectedStation(st);
        }

        if (!geolocationService.getTrackingStatus()) {
          startContinuousTracking(selectedUser.id);
        }
      } else {
        setIsActiveShift(false);
        setShiftSeconds(0);
        geolocationService.stopTracking();
      }
    } catch (err) {
      console.error('Error verificando turno activo:', err);
    }
  }, [selectedUser, workstations]);

  useEffect(() => {
    if (isAuthenticated) checkShiftStatus();
  }, [checkShiftStatus, isAuthenticated]);

  // Shift timer
  useEffect(() => {
    let interval: any = null;
    if (isActiveShift) {
      interval = setInterval(() => {
        setShiftSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isActiveShift]);

  const formatTime = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // Continuous tracking helper
  const startContinuousTracking = (usuarioId: number) => {
    geolocationService.startTracking(
      async (coords) => {
        setCurrentCoords(coords);
        try {
          const res = await api.sendLocationPing(
            usuarioId,
            coords.latitude,
            coords.longitude,
            coords.accuracy
          );
          if (res.geocerca) {
            setIsInsideStation(res.geocerca.dentroDeEstacion);
            setDetectedStation(res.geocerca.estacion);
            setDistanceToNearest(res.geocerca.distanciaMetros);
          }
        } catch (err) {
          console.error('Error enviando telemetría GPS:', err);
        }
      },
      () => {
        console.warn('Permiso o acceso GPS no disponible en este momento');
      }
    );
  };

  // Ingreso: el servidor valida el PIN (con límite de intentos) y entrega la sesión
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser || loginLoading) return;
    setLoginLoading(true);
    try {
      const me = await api.login(selectedUser.id, pinInput);
      setSelectedUser(me);
      setPinInput('');
      const stationsData = await api.getWorkstations();
      setWorkstations(stationsData);
      setIsAuthenticated(true);
      connectSocket();
    } catch (err: any) {
      setPinInput('');
      alert(err.message || 'No se pudo iniciar sesión');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    if (isActiveShift) {
      const confirm = window.confirm(
        'Tienes un turno activo. Para cerrar sesión de forma segura, primero debes registrar tu salida. ¿Deseas continuar?'
      );
      if (!confirm) return;
    }
    geolocationService.stopTracking();
    api.logout();
    disconnectSocket();
    setIsAuthenticated(false);
    setIsActiveShift(false);
    setShiftSeconds(0);
    loadData();
  };

  // Comprobar estado de permisos GPS del teléfono
  const checkGpsStatus = useCallback(async () => {
    try {
      const status = await geolocationService.checkPermissionStatus();
      setGpsPermissionStatus(status);
      if (status === 'granted') {
        try {
          const pos = await geolocationService.getCurrentPosition();
          setCurrentCoords(pos);
          setGpsErrorMsg(null);
        } catch (err: any) {
          setGpsErrorMsg(err.message);
        }
      }
    } catch (err) {
      console.error('Error comprobando estado de GPS:', err);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      checkGpsStatus();
    }
  }, [isAuthenticated, checkGpsStatus]);

  // Solicitar explícitamente permiso de ubicación al trabajador
  const handleRequestLocation = async () => {
    try {
      const granted = await geolocationService.requestPermissions();
      if (granted) {
        setGpsPermissionStatus('granted');
        const pos = await geolocationService.getCurrentPosition();
        setCurrentCoords(pos);
        setGpsErrorMsg(null);
      } else {
        setGpsPermissionStatus('denied');
        alert('Debes conceder el permiso de ubicación en tu navegador para que el sistema detecte en qué estación te encuentras.');
      }
    } catch (err: any) {
      setGpsErrorMsg(err.message);
      alert(err.message || 'Error solicitando permiso GPS');
    }
  };

  // Pre-cargar GPS en segundo plano cuando se abre el modal de cámara para que el registro sea instantáneo
  useEffect(() => {
    if (isCameraOpen) {
      geolocationService
        .getCurrentPosition({ allowCached: true, maxWaitMs: 4000 })
        .then((pos) => {
          setCurrentCoords(pos);
          setGpsPermissionStatus('granted');
        })
        .catch(() => {});
    }
  }, [isCameraOpen]);

  // Handle Check-In con Reconocimiento Facial Biométrico y GPS Real
  const handleCheckInWithPhoto = async (fotoBase64: string, similarity = 100, isVerified = true) => {
    if (!selectedUser) return;
    setActionLoading(true);

    try {
      // Usar coordenadas disponibles de inmediato (0ms de retraso si ya están en memoria)
      let pos: CoordsData | null = currentCoords || geolocationService.getLastKnownCoords();

      if (!pos) {
        try {
          pos = await geolocationService.getCurrentPosition({ allowCached: true, maxWaitMs: 3000 });
          setCurrentCoords(pos);
          setGpsPermissionStatus('granted');
          setGpsErrorMsg(null);
        } catch (gpsErr: any) {
          setActionLoading(false);
          const msg = gpsErr.message || 'No se pudo obtener la ubicación GPS de tu celular.';
          alert(
            `⚠️ UBICACIÓN GPS REQUERIDA:\n\n${msg}\n\nPara registrar tu asistencia es OBLIGATORIO que actives la ubicación GPS en tu celular y concedas los permisos en tu navegador.`
          );
          return;
        }
      }

      const res = await api.checkIn(
        selectedUser.id,
        pos.latitude,
        pos.longitude,
        pos.accuracy,
        fotoBase64,
        similarity,
        isVerified,
        'facial_biometrico'
      );

      setIsCameraOpen(false);
      setIsActiveShift(true);
      setShiftSeconds(0);

      if (res.geocerca) {
        setIsInsideStation(res.geocerca.dentroDeEstacion);
        setDetectedStation(res.geocerca.estacion);
        setDistanceToNearest(res.geocerca.distanciaMetros);
      }

      startContinuousTracking(selectedUser.id);
      if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);
      alert(`✓ Entrada confirmada con reconocimiento facial (${similarity}% de similitud). ¡Buen turno!`);
    } catch (err: any) {
      alert(err.message || 'Error al registrar entrada');
    } finally {
      setActionLoading(false);
      checkShiftStatus();
    }
  };

  // Handle Check-Out con Reconocimiento Facial Biométrico y GPS Real
  const handleCheckOutWithPhoto = async (fotoBase64: string, similarity = 100, isVerified = true) => {
    if (!selectedUser) return;
    setActionLoading(true);

    try {
      // Al registrar salida, el turno ya estaba activo y rastreando, por lo que las coordenadas son inmediatas
      const pos = currentCoords || geolocationService.getLastKnownCoords();
      let lat = pos?.latitude;
      let lng = pos?.longitude;
      let acc = pos?.accuracy;

      if (lat === undefined || lng === undefined) {
        try {
          const freshPos = await geolocationService.getCurrentPosition({ allowCached: true, maxWaitMs: 2500 });
          lat = freshPos.latitude;
          lng = freshPos.longitude;
          acc = freshPos.accuracy;
        } catch {
          console.warn('GPS no disponible al salir, procediendo con salida');
        }
      }

      await api.checkOut(
        selectedUser.id,
        lat,
        lng,
        acc,
        fotoBase64,
        similarity,
        isVerified
      );
      await geolocationService.stopTracking();

      setIsCameraOpen(false);
      setIsActiveShift(false);
      setShiftSeconds(0);
      setCurrentCoords(null);
      setDetectedStation(null);
      if ('vibrate' in navigator) navigator.vibrate([150]);
      alert(`✓ Salida confirmada con reconocimiento facial (${similarity}% de similitud). Tu jornada ha concluido.`);
    } catch (err: any) {
      alert(err.message || 'Error al registrar salida');
    } finally {
      setActionLoading(false);
      checkShiftStatus();
    }
  };

  // Simulate movement to station for indoor testing
  const handleSimulateMove = async (stationId: number) => {
    if (!selectedUser || !isActiveShift) return;
    const station = workstations.find((w) => w.id === stationId);
    if (!station) return;

    const simulatedCoords: CoordsData = {
      latitude: station.latitud,
      longitude: station.longitud,
      accuracy: 5,
      timestamp: Date.now(),
    };

    setCurrentCoords(simulatedCoords);
    const res = await api.sendLocationPing(
      selectedUser.id,
      station.latitud,
      station.longitud,
      5
    );

    if (res.geocerca) {
      setIsInsideStation(res.geocerca.dentroDeEstacion);
      setDetectedStation(res.geocerca.estacion);
      setDistanceToNearest(res.geocerca.distanciaMetros);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
          Cargando Portal del Trabajador...
        </p>
      </div>
    );
  }

  // Login Screen if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-900 to-blue-950 flex flex-col justify-center items-center px-4 py-8 font-sans">
        <div className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl border border-slate-100">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30 mb-3">
              <MapPin className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-xl font-extrabold text-slate-900">SMI Asistencia</h2>
            <p className="text-xs text-slate-500 mt-0.5">Portal de Control de Jornada</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                Selecciona tu Nombre:
              </label>
              <select
                value={selectedUser?.id || ''}
                onChange={(e) => {
                  const u = workers.find((w) => w.id === Number(e.target.value));
                  if (u) setSelectedUser(u);
                }}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-sm font-semibold rounded-xl px-3.5 py-2.5 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.nombre} ({w.codigo_empleado})
                  </option>
                ))}
              </select>
            </div>

            {selectedUser && (
              <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 text-xs">
                <p className="font-bold text-blue-900">{selectedUser.cargo}</p>
                <p className="text-[11px] text-blue-600 font-mono mt-0.5">
                  Código: {selectedUser.codigo_empleado}
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                PIN de Marcación:
              </label>
              <div className="relative">
                <input
                  type="password"
                  maxLength={6}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="Introduce tu PIN" inputMode="numeric" autoComplete="off"
                  className="w-full bg-slate-50 border border-slate-300 text-slate-900 text-center tracking-widest text-lg font-bold rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            <button
              type="submit"
              disabled={loginLoading || pinInput.length < 4}
              className="w-full py-3.5 disabled:opacity-60 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-sm rounded-xl shadow-lg shadow-blue-600/30 transition transform active:scale-95 cursor-pointer"
            >
              {loginLoading ? 'Verificando...' : 'Ingresar al Marcador'}
            </button>
          </form>
        </div>

        <p className="text-[11px] text-slate-500 text-center mt-6">
          SMI GPS Asistencia Móvil • PWA & CapacitorJS Ready
        </p>
      </div>
    );
  }

  // Main Worker Clock-In/Out Interface
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col font-sans text-slate-100">
      {/* Worker App Header (Dedicated, No Admin Links) */}
      <header className="bg-slate-950/90 border-b border-slate-800 sticky top-0 z-40 backdrop-blur-md px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shadow-md shadow-blue-600/20">
            <MapPin className="w-5 h-5 text-white" />
          </div>
          <div>
            <span className="font-extrabold text-sm tracking-tight text-white block">SMI Móvil</span>
            <span className="text-[10px] text-slate-400 font-medium block -mt-0.5">Control de Asistencia</span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Connection status */}
          <span
            className={`w-2 h-2 rounded-full ${
              isSocketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
            }`}
          />
          <button
            onClick={handleLogout}
            className="text-[11px] font-semibold text-slate-400 hover:text-white bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700/80 transition"
          >
            Cerrar Sesión
          </button>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-md w-full mx-auto px-4 py-5 flex flex-col justify-between">
        <div className="space-y-4">
          {/* Worker Profile Card */}
          <div className="bg-slate-800/70 border border-slate-700/80 rounded-2xl p-3.5 flex items-center justify-between shadow-sm">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-blue-900/60 border border-blue-500/40 flex items-center justify-center font-extrabold text-blue-300 text-sm">
                {selectedUser?.nombre
                  .split(' ')
                  .slice(0, 2)
                  .map((n) => n[0])
                  .join('')}
              </div>
              <div>
                <div className="flex items-center space-x-1.5">
                  <h3 className="font-bold text-sm text-white">{selectedUser?.nombre}</h3>
                  {selectedUser?.facial_enrolado ? (
                    <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-600/50 px-1.5 py-0.2 rounded font-bold">
                      ✓ Biometría
                    </span>
                  ) : (
                    <span className="text-[10px] bg-amber-950 text-amber-300 border border-amber-600/50 px-1.5 py-0.2 rounded font-bold">
                      Enrolar
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400">{selectedUser?.cargo}</p>
              </div>
            </div>
            <span className="text-[10px] font-mono font-bold bg-slate-900 text-blue-400 px-2 py-0.5 rounded border border-slate-700">
              {selectedUser?.codigo_empleado}
            </span>
          </div>

          {/* Tarjeta de Permiso y Conexión GPS del Celular */}
          {gpsPermissionStatus !== 'granted' ? (
            <div className="bg-amber-950/60 border border-amber-500/50 p-4 rounded-2xl flex items-center justify-between shadow-lg">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-400 flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-5 h-5 animate-bounce" />
                </div>
                <div>
                  <h4 className="font-bold text-xs text-amber-200">Permiso de Ubicación del Celular</h4>
                  <p className="text-[11px] text-amber-300/80 mt-0.5">
                    Obligatorio para verificar en qué estación de trabajo te encuentras.
                  </p>
                  {gpsErrorMsg && (
                    <p className="text-[10px] text-rose-400 font-semibold mt-1">⚠️ {gpsErrorMsg}</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={handleRequestLocation}
                className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold text-xs rounded-xl shadow transition transform active:scale-95 cursor-pointer flex-shrink-0"
              >
                Activar GPS
              </button>
            </div>
          ) : (
            <div className="bg-emerald-950/40 border border-emerald-500/30 px-3.5 py-2.5 rounded-2xl flex items-center justify-between text-xs">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-emerald-300 font-bold">Ubicación GPS del Celular Conectada</span>
              </div>
              {currentCoords && (
                <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-900/60 px-2 py-0.5 rounded border border-emerald-700/50">
                  ±{Math.round(currentCoords.accuracy)}m precisión
                </span>
              )}
            </div>
          )}

          {/* Shift Clock & Punch Card */}
          <div
            className={`rounded-3xl p-6 text-center border shadow-xl transition-all duration-300 ${
              isActiveShift
                ? 'bg-gradient-to-b from-blue-950 via-slate-900 to-slate-950 border-blue-600/70'
                : 'bg-slate-800/90 border-slate-700'
            }`}
          >
            {/* Status Badge */}
            <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-4 border border-slate-700 bg-slate-950/60 shadow-inner">
              {isActiveShift ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span className="text-emerald-400">Turno en Curso</span>
                </>
              ) : (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
                  <span className="text-slate-400">Fuera de Jornada</span>
                </>
              )}
            </div>

            {/* Timer Counter */}
            <div className="mb-6">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Tiempo Transcurrido
              </p>
              <div className="text-5xl font-black font-mono tracking-tight text-white mt-1">
                {formatTime(shiftSeconds)}
              </div>
            </div>

            {/* Big Action Button */}
            <div className="mb-4">
              {isActiveShift ? (
                <button
                  onClick={() => {
                    setCameraTipo('salida');
                    setIsCameraOpen(true);
                  }}
                  disabled={actionLoading}
                  className="w-full py-4 px-6 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-base shadow-lg shadow-rose-600/30 flex items-center justify-center space-x-2.5 transition transform active:scale-95 disabled:opacity-60 cursor-pointer"
                >
                  {actionLoading ? (
                    <RefreshCw className="w-6 h-6 animate-spin" />
                  ) : (
                    <>
                      <ScanFace className="w-6 h-6" />
                      <span>REGISTRAR SALIDA (FACIAL)</span>
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={() => {
                    setCameraTipo('entrada');
                    setIsCameraOpen(true);
                  }}
                  disabled={actionLoading}
                  className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-base shadow-lg shadow-emerald-600/30 flex items-center justify-center space-x-2.5 transition transform active:scale-95 disabled:opacity-60 cursor-pointer"
                >
                  {actionLoading ? (
                    <RefreshCw className="w-6 h-6 animate-spin" />
                  ) : (
                    <>
                      <ScanFace className="w-6 h-6" />
                      <span>REGISTRAR ENTRADA (FACIAL)</span>
                    </>
                  )}
                </button>
              )}
              <p className="text-[11px] text-slate-400 text-center mt-2 flex items-center justify-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
                <span>Reconocimiento facial biométrico con prueba de vida</span>
              </p>
            </div>

            {/* GPS Status Indicator */}
            <div className="p-3 rounded-xl text-xs font-medium border border-slate-700/60 bg-slate-950/50 flex items-center justify-center space-x-2">
              {isActiveShift ? (
                <>
                  <Navigation className="w-4 h-4 text-emerald-400 animate-spin" style={{ animationDuration: '4s' }} />
                  <span className="text-emerald-300 font-semibold">
                    GPS Activo • Transmitiendo telemetría en vivo
                  </span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 text-slate-400" />
                  <span className="text-slate-400">
                    GPS Desactivado • Tu ubicación no es compartida
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Active Geofence & Location Telemetry (Only visible when clocked in) */}
          {isActiveShift && (
            <div className="space-y-3">
              {/* Geofence Alert */}
              <div
                className={`p-4 rounded-2xl border flex items-start space-x-3 shadow-md ${
                  isInsideStation
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
                    : 'bg-amber-950/60 border-amber-500/40 text-amber-200'
                }`}
              >
                {isInsideStation ? (
                  <ShieldCheck className="w-6 h-6 text-emerald-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-6 h-6 text-amber-400 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <h4 className="font-bold text-sm text-white">
                    {isInsideStation
                      ? `En Estación: ${detectedStation?.nombre}`
                      : 'Fuera de Estación de Trabajo Asignada'}
                  </h4>
                  <p className="text-xs mt-0.5 text-slate-300">
                    {isInsideStation
                      ? `Estás dentro del radio permitido (${detectedStation?.radio_metros} metros).`
                      : distanceToNearest
                      ? `Estación más cercana: ${detectedStation?.nombre} (a ~${distanceToNearest}m).`
                      : 'Calculando distancia a estaciones de trabajo...'}
                  </p>
                </div>
              </div>

              {/* Coordinates Pill */}
              {currentCoords && (
                <div className="bg-slate-800/60 border border-slate-700 p-3.5 rounded-2xl text-xs shadow-sm">
                  <div className="flex items-center justify-between text-slate-300 mb-2">
                    <span className="flex items-center font-semibold">
                      <Compass className="w-4 h-4 mr-1.5 text-blue-400" />
                      Telemetría GPS
                    </span>
                    <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-700/60">
                      ±{Math.round(currentCoords.accuracy)}m precisión
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                    <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800">
                      <span className="block text-[9px] text-slate-500 font-sans uppercase">Latitud</span>
                      <span className="text-white font-bold">{currentCoords.latitude.toFixed(6)}</span>
                    </div>
                    <div className="bg-slate-900/80 p-2 rounded-lg border border-slate-800">
                      <span className="block text-[9px] text-slate-500 font-sans uppercase">Longitud</span>
                      <span className="text-white font-bold">{currentCoords.longitude.toFixed(6)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Simulación de movimiento: solo desarrollo o VITE_ENABLE_SIMULATION=true */}
              {(import.meta.env.DEV || import.meta.env.VITE_ENABLE_SIMULATION === 'true') && (
              <div className="bg-slate-800/40 border border-slate-700/60 p-3 rounded-2xl text-xs">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                  Simular Movimiento (Pruebas de Geocerca):
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {workstations.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => handleSimulateMove(ws.id)}
                      className="px-2.5 py-1 text-[11px] bg-slate-800 border border-slate-600 hover:bg-blue-600 hover:border-blue-500 text-slate-200 font-semibold rounded-lg transition"
                    >
                      📍 {ws.nombre.split(' ')[0]}
                    </button>
                  ))}
                </div>
              </div>
              )}
            </div>
          )}
        </div>

        {/* Footer info & Privacy note */}
        <div className="mt-6 pt-4 border-t border-slate-800 text-center text-[10px] text-slate-500">
          <p>🔒 Tu privacidad está protegida. El rastreo GPS solo opera durante tu turno activo.</p>
          <p className="mt-1">SMI GPS • PWA & Capacitor Móvil</p>
        </div>
      </main>

      {/* Modal de Reconocimiento Facial Biométrico y Prueba de Vida */}
      {selectedUser && (
        <BiometricVerificationModal
          isOpen={isCameraOpen}
          onClose={() => setIsCameraOpen(false)}
          tipo={cameraTipo}
          worker={selectedUser}
          onVerificationSuccess={(result) => {
            setIsCameraOpen(false);
            if (cameraTipo === 'entrada') {
              handleCheckInWithPhoto(result.photoBase64, result.similarity, result.isVerified);
            } else {
              handleCheckOutWithPhoto(result.photoBase64, result.similarity, result.isVerified);
            }
          }}
        />
      )}
    </div>
  );
};
