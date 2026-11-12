import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, auth } from '../services/api';
import { socket, connectSocket, disconnectSocket } from '../services/socket';
import { geolocationService, type CoordsData } from '../services/geolocation';
import type { Usuario, EstacionTrabajo } from '../types';
import { ShieldCheck, AlertTriangle, Compass, RefreshCw, ScanFace } from 'lucide-react';
import { BiometricVerificationModal } from '../components/BiometricVerificationModal';
import { faceRecognitionService } from '../services/faceRecognition';
import { eyeBlinkService } from '../services/eyeBlink';
import { PushAlertCard } from '../components/PushAlertCard';
import { AuthLayout } from '../components/AuthLayout';
import { BrandLogo } from '../components/BrandLogo';
import { syncPush, releasePush } from '../services/push';

export const WorkerPage: React.FC = () => {
  const [workers, setWorkers] = useState<Usuario[]>([]);
  const [workstations, setWorkstations] = useState<EstacionTrabajo[]>([]);
  const [selectedUser, setSelectedUser] = useState<Usuario | null>(null);

  // Authentication by PIN
  const [pinInput, setPinInput] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => Boolean(auth.getToken()));
  const [loginLoading, setLoginLoading] = useState<boolean>(false);
  const [alertaActiva, setAlertaActiva] = useState<{ id: number | null; mensaje: string } | null>(null);

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

  // Control de frecuencia: el GPS puede avisar cada segundo, pero guardar un punto por segundo llenaría la base
  // de datos y saturaría el servidor. Se envía un punto cada 15 s, o antes (mín. 5 s) si el trabajador se movió.
  const lastPingRef = useRef<{ t: number; lat: number; lng: number } | null>(null);

  const metersBetween = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const rad = (x: number) => (x * Math.PI) / 180;
    const a =
      Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 6371e3 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // Continuous tracking helper
  const startContinuousTracking = (usuarioId: number) => {
    lastPingRef.current = null;
    geolocationService.startTracking(
      async (coords) => {
        setCurrentCoords(coords);

        const last = lastPingRef.current;
        const now = Date.now();
        if (last) {
          const elapsed = now - last.t;
          const moved = metersBetween(last.lat, last.lng, coords.latitude, coords.longitude);
          const toca = elapsed >= 15_000 || (moved >= 25 && elapsed >= 5_000);
          if (!toca) return;
        }
        lastPingRef.current = { t: now, lat: coords.latitude, lng: coords.longitude };

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

  const handleLogout = async () => {
    if (isActiveShift) {
      const confirm = window.confirm(
        'Tiene un turno activo. Para cerrar sesión de forma segura, primero debe registrar su salida. ¿Desea continuar?'
      );
      if (!confirm) return;
    }
    geolocationService.stopTracking();
    // Antes de cerrar la sesión se desvincula este celular, para que las alertas de este trabajador no lleguen a otra persona
    // (con un tope de 2.5 s por si no hay red)
    await Promise.race([releasePush(), new Promise((resolve) => setTimeout(resolve, 2500))]);
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

  // Recepción de alertas: por el socket (app abierta), por el service worker (app visible) o al tocar la notificación
  useEffect(() => {
    if (!isAuthenticated) return;

    const mostrar = (id: number | null, mensaje: string) => {
      setAlertaActiva({ id, mensaje });
      if ('vibrate' in navigator) navigator.vibrate([300, 150, 300, 150, 600]);
    };

    const onSocketAlert = (a: { id: number; mensaje: string }) => mostrar(a.id, a.mensaje);
    socket.on('alerta', onSocketAlert);

    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === 'alerta') mostrar(e.data.id ?? null, e.data.mensaje || '');
      // El trabajador tocó la notificación del sistema: queda como leída
      if (e.data?.type === 'alerta-abierta' && e.data.id) api.ackAlert(e.data.id).catch(() => {});
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);

    // La notificación abrió la app con /?alerta=ID: se marca como leída y se limpia la dirección
    const url = new URL(window.location.href);
    const alertaId = Number(url.searchParams.get('alerta'));
    if (alertaId) {
      api.ackAlert(alertaId).catch(() => {});
      url.searchParams.delete('alerta');
      window.history.replaceState({}, '', url.pathname + url.search);
    }

    // Si ya había dado permiso, se vuelve a registrar este celular en el servidor (sin preguntar nada)
    syncPush();

    return () => {
      socket.off('alerta', onSocketAlert);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      checkGpsStatus();
      // Descarga en segundo plano el módulo de parpadeo para que el modal abra sin esperas
      eyeBlinkService.load();
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
        alert('Debe conceder el permiso de ubicación en su navegador para que el sistema detecte en qué estación se encuentra.');
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
          const msg = gpsErr.message || 'No se pudo obtener la ubicación GPS de su celular.';
          alert(
            `UBICACIÓN GPS REQUERIDA:\n\n${msg}\n\nPara registrar su asistencia es obligatorio activar la ubicación GPS en su celular y conceder los permisos en su navegador.`
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
      alert(`Entrada confirmada con reconocimiento facial (${similarity}% de similitud). Buen turno.`);
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
      alert(`Salida confirmada con reconocimiento facial (${similarity}% de similitud). Su jornada ha concluido.`);
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
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-100 p-4">
        <div className="mb-3 h-10 w-10 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
        <p className="text-sm text-slate-600">Cargando…</p>
      </div>
    );
  }

  // Pantalla de ingreso
  if (!isAuthenticated) {
    return (
      <AuthLayout
        titulo="Iniciar sesión"
        subtitulo="Seleccione su nombre e ingrese su PIN para registrar su asistencia."
        panelTitulo="Control de asistencia y geolocalización"
        panelTexto="Registre su entrada y salida con reconocimiento facial y ubicación verificada en su estación de trabajo."
      >
        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label htmlFor="trabajador" className="field-label">
              Trabajador
            </label>
            <select
              id="trabajador"
              value={selectedUser?.id || ''}
              onChange={(e) => {
                const u = workers.find((w) => w.id === Number(e.target.value));
                if (u) setSelectedUser(u);
              }}
              className="field"
            >
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.nombre} ({w.codigo_empleado})
                </option>
              ))}
            </select>
            {selectedUser && (
              <p className="mt-1.5 text-sm text-slate-600">
                {selectedUser.cargo} · Código {selectedUser.codigo_empleado}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="pin" className="field-label">
              PIN
            </label>
            <input
              id="pin"
              type="password"
              maxLength={6}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder="Ingrese su PIN"
              inputMode="numeric"
              autoComplete="off"
              className="field"
            />
          </div>

          <button type="submit" disabled={loginLoading || pinInput.length < 4} className="btn-primary w-full">
            {loginLoading ? 'Verificando…' : 'Ingresar'}
          </button>
        </form>
      </AuthLayout>
    );
  }

  // Pantalla principal del trabajador
  return (
    <div
      className="flex min-h-screen flex-col bg-slate-100 text-slate-900"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Encabezado institucional */}
      <header className="sticky top-0 z-40 bg-brand-600 pb-3 pt-[calc(env(safe-area-inset-top)_+_0.75rem)] text-white">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <BrandLogo variant="blanco" className="h-9 w-auto" />
            <span className="hidden border-l border-white/30 pl-3 text-sm font-medium sm:block">Control de asistencia</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2 text-sm text-brand-100">
              <span className={`h-2 w-2 ${isSocketConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              {isSocketConnected ? 'Conectado' : 'Sin conexión'}
            </span>
            <button
              onClick={handleLogout}
              className="rounded border border-white/40 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/10"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>

      {/* Alerta del supervisor (con la app abierta) */}
      {alertaActiva && (
        <div className="fixed inset-x-0 top-0 z-[60] p-3 pt-[calc(env(safe-area-inset-top)_+_0.75rem)]">
          <div className="mx-auto max-w-xl border border-slate-300 border-l-4 border-l-amber-600 bg-white p-4 shadow-xl">
            <p className="text-sm font-semibold text-amber-800">Alerta de su supervisor</p>
            <p className="mt-1.5 text-base leading-snug text-slate-900">{alertaActiva.mensaje}</p>
            <button
              type="button"
              onClick={() => {
                if (alertaActiva.id) api.ackAlert(alertaActiva.id).catch(() => {});
                setAlertaActiva(null);
              }}
              className="btn-primary mt-4 w-full"
            >
              Entendido
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 py-5">
        <div className="space-y-4">
          {/* Datos del trabajador */}
          <section className="panel flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center bg-brand-600 text-sm font-semibold text-white">
                {selectedUser?.nombre
                  .split(' ')
                  .slice(0, 2)
                  .map((n) => n[0])
                  .join('')}
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900">{selectedUser?.nombre}</h2>
                <p className="text-sm text-slate-600">
                  {selectedUser?.cargo} · {selectedUser?.codigo_empleado}
                </p>
              </div>
            </div>
            {selectedUser?.facial_enrolado ? (
              <span className="tag shrink-0 whitespace-nowrap border-green-200 bg-green-50 text-green-800">Rostro registrado</span>
            ) : (
              <span className="tag shrink-0 whitespace-nowrap border-amber-200 bg-amber-50 text-amber-800">Rostro pendiente</span>
            )}
          </section>

          {/* Alertas del supervisor en el celular (push) */}
          <PushAlertCard />

          {/* Ubicación (GPS) del celular */}
          {gpsPermissionStatus !== 'granted' ? (
            <section className="panel border-l-4 border-l-amber-600 p-4">
              <h3 className="text-sm font-semibold text-slate-900">Se requiere activar la ubicación</h3>
              <p className="mt-1 text-sm text-slate-600">
                Es obligatoria para verificar en qué estación de trabajo se encuentra.
              </p>
              {gpsErrorMsg && <p className="mt-1 text-sm font-medium text-red-700">{gpsErrorMsg}</p>}
              <button type="button" onClick={handleRequestLocation} className="btn-primary btn-sm mt-3">
                Activar ubicación
              </button>
            </section>
          ) : (
            <section className="panel flex items-center justify-between px-4 py-3 text-sm">
              <span className="flex items-center gap-2 font-medium text-slate-800">
                <span className="h-2 w-2 bg-green-600" />
                Ubicación del celular activa
              </span>
              {currentCoords && <span className="text-slate-600">Precisión ±{Math.round(currentCoords.accuracy)} m</span>}
            </section>
          )}

          {/* Jornada: reloj y registro */}
          <section className="panel">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Jornada</h3>
              {isActiveShift ? (
                <span className="tag border-green-200 bg-green-50 text-green-800">
                  <span className="h-1.5 w-1.5 bg-green-600" />
                  En turno
                </span>
              ) : (
                <span className="tag border-slate-300 bg-slate-50 text-slate-600">
                  <span className="h-1.5 w-1.5 bg-slate-400" />
                  Fuera de jornada
                </span>
              )}
            </div>

            <div className="px-4 py-6 text-center">
              <p className="text-sm text-slate-600">Tiempo transcurrido</p>
              <p className="mt-1 text-5xl font-semibold tabular-nums text-slate-900">{formatTime(shiftSeconds)}</p>
            </div>

            <div className="px-4 pb-4">
              {isActiveShift ? (
                <button
                  onClick={() => {
                    setCameraTipo('salida');
                    setIsCameraOpen(true);
                  }}
                  disabled={actionLoading}
                  className="btn-danger w-full py-3.5 text-base"
                >
                  {actionLoading ? (
                    <RefreshCw className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      <ScanFace className="h-5 w-5" />
                      Registrar salida
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
                  className="btn-primary w-full py-3.5 text-base"
                >
                  {actionLoading ? (
                    <RefreshCw className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      <ScanFace className="h-5 w-5" />
                      Registrar entrada
                    </>
                  )}
                </button>
              )}
              <p className="mt-2 text-center text-sm text-slate-600">
                Se verificará su identidad con reconocimiento facial y prueba de vida.
              </p>
            </div>

            <div className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <ShieldCheck className={`h-4 w-4 flex-shrink-0 ${isActiveShift ? 'text-green-700' : 'text-slate-500'}`} />
              <span className={isActiveShift ? 'text-green-800' : 'text-slate-600'}>
                {isActiveShift
                  ? 'GPS activo: su ubicación se envía durante el turno.'
                  : 'GPS inactivo: su ubicación no se comparte fuera del turno.'}
              </span>
            </div>
          </section>

          {/* Estación y ubicación (solo con turno activo) */}
          {isActiveShift && (
            <div className="space-y-4">
              <section
                className={`panel flex items-start gap-3 border-l-4 p-4 ${
                  isInsideStation ? 'border-l-green-700' : 'border-l-amber-600'
                }`}
              >
                {isInsideStation ? (
                  <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-700" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" />
                )}
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    {isInsideStation ? `En estación: ${detectedStation?.nombre}` : 'Fuera de su estación de trabajo'}
                  </h3>
                  <p className="mt-0.5 text-sm text-slate-600">
                    {isInsideStation
                      ? `Se encuentra dentro del radio permitido (${detectedStation?.radio_metros} metros).`
                      : distanceToNearest
                      ? `Estación más cercana: ${detectedStation?.nombre}, a unos ${distanceToNearest} m.`
                      : 'Calculando la distancia a las estaciones de trabajo…'}
                  </p>
                </div>
              </section>

              {currentCoords && (
                <section className="panel p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <Compass className="h-4 w-4 text-slate-500" />
                      Coordenadas GPS
                    </h3>
                    <span className="text-sm text-slate-600">±{Math.round(currentCoords.accuracy)} m</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div className="border border-slate-200 bg-slate-50 p-2.5">
                      <dt className="text-slate-600">Latitud</dt>
                      <dd className="mt-0.5 font-semibold tabular-nums text-slate-900">{currentCoords.latitude.toFixed(6)}</dd>
                    </div>
                    <div className="border border-slate-200 bg-slate-50 p-2.5">
                      <dt className="text-slate-600">Longitud</dt>
                      <dd className="mt-0.5 font-semibold tabular-nums text-slate-900">{currentCoords.longitude.toFixed(6)}</dd>
                    </div>
                  </dl>
                </section>
              )}

              {/* Simulación de movimiento: solo desarrollo o VITE_ENABLE_SIMULATION=true */}
              {(import.meta.env.DEV || import.meta.env.VITE_ENABLE_SIMULATION === 'true') && (
                <section className="panel border-dashed p-4">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">Simular movimiento (pruebas de geocerca)</h3>
                  <div className="flex flex-wrap gap-2">
                    {workstations.map((ws) => (
                      <button key={ws.id} onClick={() => handleSimulateMove(ws.id)} className="btn-secondary btn-sm">
                        {ws.nombre.split(' ')[0]}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <footer className="mt-8 border-t border-slate-300 pt-4 text-center text-sm text-slate-600">
          <p>Su privacidad está protegida: el rastreo GPS solo opera durante su turno activo.</p>
        </footer>
      </main>

      {/* Reconocimiento facial y prueba de vida */}
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
