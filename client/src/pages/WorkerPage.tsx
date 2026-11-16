import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, auth } from '../services/api';
import { socket, connectSocket, disconnectSocket } from '../services/socket';
import { geolocationService, type CoordsData } from '../services/geolocation';
import type { Usuario, EstacionTrabajo, TipoVerificacion } from '../types';
import { ShieldCheck, AlertTriangle, Compass, RefreshCw, ScanFace } from 'lucide-react';
import { BiometricVerificationModal } from '../components/BiometricVerificationModal';
import { faceRecognitionService } from '../services/faceRecognition';
import { eyeBlinkService } from '../services/eyeBlink';
import { PushAlertCard } from '../components/PushAlertCard';
import { AuthLayout } from '../components/AuthLayout';
import { BrandLogo } from '../components/BrandLogo';
import { syncPush, releasePush } from '../services/push';
import { esAppNativa, nativeTracker, permisosCompletos, type EstadoRastreo } from '../services/nativeTracker';
import { NativePermissionsModal } from '../components/NativePermissionsModal';

export const WorkerPage: React.FC = () => {
  const [workers, setWorkers] = useState<Usuario[]>([]);
  const [workstations, setWorkstations] = useState<EstacionTrabajo[]>([]);
  const [selectedUser, setSelectedUser] = useState<Usuario | null>(null);

  // Authentication by PIN
  const [pinInput, setPinInput] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => Boolean(auth.getToken()));
  const [loginLoading, setLoginLoading] = useState<boolean>(false);
  const [alertaActiva, setAlertaActiva] = useState<{ id: number | null; mensaje: string } | null>(null);

  // Precisión GPS exigida por el servidor y estado de la señal
  const [gpsCfg, setGpsCfg] = useState({ maxPrecisionCheckin: 50, maxPrecisionPing: 100, maxAgeMs: 30000 });
  const gpsCfgRef = useRef(gpsCfg);
  gpsCfgRef.current = gpsCfg;
  const [gpsBuscando, setGpsBuscando] = useState<boolean>(false);
  const [gpsMensaje, setGpsMensaje] = useState<string>('');
  const [gpsImprecisa, setGpsImprecisa] = useState<number | null>(null); // precisión actual (m) si es insuficiente
  const [wakeLockActivo, setWakeLockActivo] = useState<boolean>(false);
  // App Android: estado del servicio de rastreo en segundo plano y guía de permisos
  const [estadoNativo, setEstadoNativo] = useState<EstadoRastreo | null>(null);
  const [permisosAbierto, setPermisosAbierto] = useState<boolean>(false);
  const [errorNativo, setErrorNativo] = useState<string | null>(null);
  // El turno activo se inició en otro dispositivo: este no registra ubicación (evita mezclar dos celulares)
  const [turnoEnOtroDispositivo, setTurnoEnOtroDispositivo] = useState<boolean>(false);

  // Shift & tracking state
  const [isActiveShift, setIsActiveShift] = useState<boolean>(false);
  const [shiftSeconds, setShiftSeconds] = useState<number>(0);

  // Modal de Cámara de Evidencia Obligatoria
  const [isCameraOpen, setIsCameraOpen] = useState<boolean>(false);
  const [cameraTipo, setCameraTipo] = useState<TipoVerificacion>('entrada');
  // Almuerzo dentro del turno (el GPS NO se detiene mientras tanto)
  const [almuerzo, setAlmuerzo] = useState<{
    enAlmuerzo: boolean;
    segundosBase: number;
    desde: number;
    realizados: number;
    maximo: number;
    permitidoMinutos: number;
  } | null>(null);
  const [tickAlmuerzo, setTickAlmuerzo] = useState<number>(0);

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
  // Si no hay conexión con el servidor al abrir la app (por ejemplo, justo después de reiniciar el celular) se reintenta solo
  const [cargaError, setCargaError] = useState<string | null>(null);
  const [intentosCarga, setIntentosCarga] = useState<number>(0);

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
          setCargaError(null);
          setLoading(false);
          return;
        } catch (err: any) {
          // Solo una respuesta 401/403 del servidor significa sesión vencida o inválida (la petición ya la cierra).
          // Una falla de red o un error del servidor NO cierra la sesión: se conserva y se reintenta.
          if (err?.status !== 401 && err?.status !== 403) throw err;
          api.logout();
          setIsAuthenticated(false);
        }
      }

      const publicWorkers = await api.getPublicWorkers();
      const asUsers: Usuario[] = publicWorkers.map((w) => ({ ...w, correo: '', rol: 'trabajador', activo: true }));
      setWorkers(asUsers);
      if (asUsers.length > 0) setSelectedUser(asUsers[0]);
      setCargaError(null);
      setLoading(false);
    } catch (err: any) {
      console.error('Error cargando datos del trabajador:', err);
      // Sin conexión (o servidor caído): se muestra el aviso con reintento automático en vez de una lista vacía
      setCargaError(err?.status ? `El servidor respondió con un error (${err.status}).` : 'No se pudo conectar con el servidor.');
      setLoading(true); // pantalla de "sin conexión" con reintento, nunca una lista de nombres vacía
      setIntentosCarga((n) => n + 1);
    }
  }, []);

  // Reintento automático cada 5 s, y al recuperar internet o al volver a la app
  useEffect(() => {
    if (!cargaError) return;
    const t = setTimeout(() => loadData(), 5000);
    const reintentar = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    window.addEventListener('online', reintentar);
    document.addEventListener('visibilitychange', reintentar);
    return () => {
      clearTimeout(t);
      window.removeEventListener('online', reintentar);
      document.removeEventListener('visibilitychange', reintentar);
    };
  }, [cargaError, intentosCarga, loadData]);

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

        const alm = workerInfo.almuerzo;
        setAlmuerzo(
          alm?.habilitado
            ? {
                enAlmuerzo: Boolean(alm.enAlmuerzo),
                segundosBase: alm.segundosEnAlmuerzo || 0,
                desde: Date.now(),
                realizados: alm.realizados || 0,
                maximo: alm.maximo || 1,
                permitidoMinutos: alm.permitidoMinutos || 60,
              }
            : null
        );

        if (workerInfo.en_otro_dispositivo) {
          // El turno es de otro teléfono: aquí no se rastrea (el servidor ignoraría esos puntos)
          setTurnoEnOtroDispositivo(true);
          geolocationService.stopTracking();
          if (esAppNativa) nativeTracker.detener();
        } else {
          setTurnoEnOtroDispositivo(false);
          if (!geolocationService.getTrackingStatus()) {
            startContinuousTracking(selectedUser.id);
          }
        }
      } else {
        setTurnoEnOtroDispositivo(false);
        setAlmuerzo(null);
        setIsActiveShift(false);
        setShiftSeconds(0);
        geolocationService.stopTracking();
        if (esAppNativa) nativeTracker.detener();
      }
    } catch (err) {
      console.error('Error verificando turno activo:', err);
    }
  }, [selectedUser, workstations]);

  useEffect(() => {
    if (isAuthenticated) checkShiftStatus();
  }, [checkShiftStatus, isAuthenticated]);

  // App Android: la ubicación la envía el servicio nativo. Aquí solo se refresca lo que ve el trabajador
  // (zona, estado del servicio) y, si el servicio se hubiera detenido, se vuelve a iniciar.
  useEffect(() => {
    if (!esAppNativa || !isActiveShift) return;
    const refrescar = () => {
      if (document.visibilityState !== 'visible') return;
      checkShiftStatus();
      nativeTracker.estado().then(setEstadoNativo).catch(() => {});
    };
    const id = setInterval(refrescar, 15_000);
    document.addEventListener('visibilitychange', refrescar);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refrescar);
    };
  }, [isActiveShift, checkShiftStatus]);

  // Reloj del almuerzo
  useEffect(() => {
    if (!almuerzo?.enAlmuerzo) return;
    const t = setInterval(() => setTickAlmuerzo((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [almuerzo?.enAlmuerzo]);

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
    // App Android: el servicio nativo captura y envía la ubicación aunque la pantalla esté apagada
    if (esAppNativa) {
      nativeTracker
        .asegurarRastreo()
        .then((est) => {
          setEstadoNativo(est);
          setErrorNativo(null);
        })
        .catch((err: any) => {
          if (err?.data?.codigo === 'OTRO_DISPOSITIVO') {
            setTurnoEnOtroDispositivo(true);
            return;
          }
          setErrorNativo(err?.message || 'No se pudo iniciar el rastreo en segundo plano');
        });
      return;
    }
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
        // Un punto impreciso no se envía: dejaría al trabajador "ubicado" donde no está
        if (coords.accuracy > gpsCfgRef.current.maxPrecisionPing) {
          setGpsImprecisa(Math.round(coords.accuracy));
          return;
        }
        setGpsImprecisa(null);
        lastPingRef.current = { t: now, lat: coords.latitude, lng: coords.longitude };

        try {
          const res = await api.sendLocationPing(
            usuarioId,
            coords.latitude,
            coords.longitude,
            coords.accuracy,
            Date.now() - coords.timestamp
          );
          if (res.imprecisa) setGpsImprecisa(res.precision);
          if (res.geocerca) {
            setIsInsideStation(res.geocerca.dentroDeEstacion);
            setDetectedStation(res.geocerca.estacion);
            setDistanceToNearest(res.geocerca.distanciaMetros);
          }
        } catch (err: any) {
          if (err?.data?.codigo === 'OTRO_DISPOSITIVO') {
            setTurnoEnOtroDispositivo(true);
            geolocationService.stopTracking();
            return;
          }
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

  // Precisión GPS que exige el servidor
  useEffect(() => {
    if (isAuthenticated) api.getGpsConfig().then(setGpsCfg).catch(() => {});
  }, [isAuthenticated]);

  // Durante el turno: mantener la pantalla encendida (el navegador deja de entregar el GPS con la pantalla
  // apagada o la app en segundo plano) y reportar la posición al instante cuando se vuelve a la app.
  useEffect(() => {
    if (esAppNativa || !isActiveShift || !selectedUser || turnoEnOtroDispositivo) return; // en la app Android no hace falta mantener la pantalla encendida
    const usuarioId = selectedUser.id;
    let lock: WakeLockSentinel | null = null;

    const mantenerPantalla = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          lock = await navigator.wakeLock.request('screen');
          setWakeLockActivo(true);
          lock.addEventListener('release', () => setWakeLockActivo(false));
        }
      } catch {
        setWakeLockActivo(false);
      }
    };

    const reportarAhora = async () => {
      try {
        const r = await geolocationService.getPrecisePosition({ maxAccuracy: gpsCfgRef.current.maxPrecisionPing, waitMs: 8000 });
        setCurrentCoords(r.coords);
        if (!r.precise) {
          setGpsImprecisa(Math.round(r.coords.accuracy));
          return;
        }
        setGpsImprecisa(null);
        lastPingRef.current = { t: Date.now(), lat: r.coords.latitude, lng: r.coords.longitude };
        const res = await api.sendLocationPing(usuarioId, r.coords.latitude, r.coords.longitude, r.coords.accuracy, Date.now() - r.coords.timestamp);
        if (res.geocerca) {
          setIsInsideStation(res.geocerca.dentroDeEstacion);
          setDetectedStation(res.geocerca.estacion);
          setDistanceToNearest(res.geocerca.distanciaMetros);
        }
      } catch {
        /* sin señal por ahora: el seguimiento normal lo intentará de nuevo */
      }
    };

    const alVolver = () => {
      if (document.visibilityState === 'visible') {
        mantenerPantalla();
        reportarAhora();
      }
    };

    mantenerPantalla();
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      lock?.release().catch(() => {});
      setWakeLockActivo(false);
    };
  }, [isActiveShift, selectedUser, turnoEnOtroDispositivo]);

  // Un administrador cerró el turno (salida forzada): se avisa al instante y se detiene el rastreo
  useEffect(() => {
    if (!isAuthenticated) return;
    const onCerrado = () => {
      setAlertaActiva({ id: null, mensaje: 'Un administrador registró su salida. Su turno ha terminado y su ubicación ya no se comparte.' });
      if ('vibrate' in navigator) navigator.vibrate([300, 150, 300]);
      checkShiftStatus();
    };
    socket.on('turno_cerrado', onCerrado);
    return () => {
      socket.off('turno_cerrado', onCerrado);
    };
  }, [isAuthenticated, checkShiftStatus]);

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
    if (!esAppNativa) syncPush();

    // App Android: las alertas llegan como notificación del sistema (las trae el servicio de rastreo).
    // Al tocarla se abre la app con la alerta: se muestra completa y queda marcada como leída.
    let revisarAlertaNativa: (() => void) | null = null;
    if (esAppNativa) {
      revisarAlertaNativa = async () => {
        if (document.visibilityState !== 'visible') return;
        const a = await nativeTracker.alertaAbierta().catch(() => null);
        if (a?.id) {
          mostrar(a.id, a.mensaje || '');
          api.ackAlert(a.id).catch(() => {});
        }
      };
      revisarAlertaNativa();
      document.addEventListener('visibilitychange', revisarAlertaNativa);
    }

    return () => {
      socket.off('alerta', onSocketAlert);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
      if (revisarAlertaNativa) document.removeEventListener('visibilitychange', revisarAlertaNativa);
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

  // Antes de abrir la cámara para marcar ENTRADA se consigue una ubicación precisa; así el trabajador no
  // hace la verificación facial para descubrir después que el GPS no servía.
  const prepararUbicacionPrecisa = async (): Promise<boolean> => {
    const maxPrec = gpsCfgRef.current.maxPrecisionCheckin;
    setGpsBuscando(true);
    setGpsMensaje('Obteniendo ubicación precisa…');
    try {
      const r = await geolocationService.getPrecisePosition({
        maxAccuracy: maxPrec,
        waitMs: 15000,
        onProgress: (a) => setGpsMensaje(`Obteniendo ubicación precisa… (±${Math.round(a)} m)`),
      });
      setCurrentCoords(r.coords);
      setGpsPermissionStatus('granted');
      setGpsErrorMsg(null);
      if (!r.precise) {
        alert(
          `Su ubicación no es lo bastante precisa (±${Math.round(r.coords.accuracy)} m). Se requiere ±${maxPrec} m o menos.\n\n` +
            '• Active la ubicación de alta precisión (Android: Ajustes → Ubicación).\n' +
            '• Permita la ubicación "precisa" para el navegador, no la "aproximada".\n' +
            '• Salga a un lugar abierto, lejos de techos y paredes.\n\nLuego intente de nuevo.'
        );
        return false;
      }
      return true;
    } catch (err: any) {
      alert(err.message || 'No se pudo obtener la ubicación GPS.');
      return false;
    } finally {
      setGpsBuscando(false);
    }
  };

  const continuarMarcacion = async (tipo: 'entrada' | 'salida') => {
    setCameraTipo(tipo);
    if (tipo === 'entrada' && !(await prepararUbicacionPrecisa())) return;
    setIsCameraOpen(true);
  };

  const iniciarMarcacion = async (tipo: 'entrada' | 'salida') => {
    if (gpsBuscando) return;
    // App Android: antes de iniciar el turno deben estar concedidos los permisos del rastreo en segundo plano
    if (esAppNativa && tipo === 'entrada') {
      try {
        if (!permisosCompletos(await nativeTracker.estado())) {
          setPermisosAbierto(true);
          return;
        }
      } catch {
        /* si no se puede consultar, se deja continuar y el inicio del servicio avisará */
      }
    }
    await continuarMarcacion(tipo);
  };

  // Handle Check-In con Reconocimiento Facial Biométrico y GPS Real
  const handleCheckInWithPhoto = async (fotoBase64: string, similarity = 100) => {
    if (!selectedUser) return;
    setActionLoading(true);

    try {
      // Lectura GPS fresca justo antes de registrar (la verificación facial tardó unos segundos).
      // Nunca se usa una posición vieja: en un vehículo una posición de hace un minuto está a ~1 km.
      const maxPrec = gpsCfgRef.current.maxPrecisionCheckin;
      let pos: CoordsData | null = null;
      try {
        const lectura = await geolocationService.getPrecisePosition({ maxAccuracy: maxPrec, waitMs: 6000 });
        if (lectura.precise) pos = lectura.coords;
      } catch {
        /* se prueba con la lectura de la verificación previa */
      }
      if (!pos && currentCoords && currentCoords.accuracy <= maxPrec && Date.now() - currentCoords.timestamp <= 45000) {
        pos = currentCoords;
      }
      if (!pos) {
        setActionLoading(false);
        alert(
          `Su ubicación no es lo bastante precisa. Se requiere ±${maxPrec} m o menos.\n\n` +
            '• Active la ubicación de alta precisión en su celular.\n' +
            '• Permita la ubicación "precisa" para el navegador.\n' +
            '• Salga a un lugar abierto, lejos de techos y paredes.\n\nLuego intente de nuevo.'
        );
        return;
      }
      setCurrentCoords(pos);

      const res = await api.checkIn(
        selectedUser.id,
        pos.latitude,
        pos.longitude,
        pos.accuracy,
        fotoBase64,
        Date.now() - pos.timestamp
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

  // Inicio / fin del almuerzo (con verificación facial). El rastreo GPS continúa sin cambios.
  const handleAlmuerzoConFoto = async (tipo: 'almuerzo_inicio' | 'almuerzo_fin', fotoBase64: string) => {
    setActionLoading(true);
    try {
      if (tipo === 'almuerzo_inicio') {
        const r = await api.lunchStart(fotoBase64);
        if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);
        alert(
          `Almuerzo iniciado. Tiene ${r.almuerzo.permitidoMinutos} minutos. Su ubicación sigue registrándose. Al volver, toque "Terminar almuerzo".`
        );
      } else {
        const r = await api.lunchEnd(fotoBase64);
        if ('vibrate' in navigator) navigator.vibrate([150]);
        alert(
          r.almuerzo.excedido
            ? `Almuerzo terminado: ${r.almuerzo.minutos} min. Se pasó del tiempo permitido (${r.almuerzo.permitidoMinutos} min).`
            : `Almuerzo terminado (${r.almuerzo.minutos} min). Buen provecho y buen turno.`
        );
      }
    } catch (err: any) {
      alert(err.message || 'No se pudo registrar el almuerzo');
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

      // App Android: se envían los últimos puntos antes de cerrar el turno (después el servidor ya no los acepta)
      if (esAppNativa) await nativeTracker.enviarPendientes();

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
      if (esAppNativa) await nativeTracker.detener();

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
        <p className="text-sm text-slate-600">{cargaError ? 'Sin conexión con el servidor' : 'Cargando…'}</p>
        {cargaError && (
          <div className="mt-3 max-w-xs text-center">
            <p className="text-sm text-slate-600">
              {cargaError} Verifique que tenga internet. Se reintentará automáticamente; su sesión no se ha cerrado.
            </p>
            <button type="button" onClick={() => loadData()} className="btn-primary mt-3">
              Reintentar ahora
            </button>
          </div>
        )}
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
          {!esAppNativa && <PushAlertCard />}

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
                <div className="space-y-2.5">
                  {/* Almuerzo en curso: reloj y botón para terminarlo */}
                  {almuerzo?.enAlmuerzo && !turnoEnOtroDispositivo && (() => {
                    void tickAlmuerzo;
                    const seg = almuerzo.segundosBase + Math.floor((Date.now() - almuerzo.desde) / 1000);
                    const excedido = seg > almuerzo.permitidoMinutos * 60;
                    return (
                      <div className={`border-l-4 p-3 ${excedido ? 'border-l-red-700 bg-red-50' : 'border-l-brand-600 bg-brand-50'}`}>
                        <p className="text-sm font-semibold text-slate-900">En almuerzo</p>
                        <p className={`mt-0.5 text-3xl font-semibold tabular-nums ${excedido ? 'text-red-800' : 'text-brand-800'}`}>
                          {formatTime(seg)}
                        </p>
                        <p className={`mt-0.5 text-sm ${excedido ? 'font-semibold text-red-800' : 'text-slate-600'}`}>
                          {excedido
                            ? `Se pasó del tiempo permitido (${almuerzo.permitidoMinutos} min). Termine su almuerzo.`
                            : `Tiene ${almuerzo.permitidoMinutos} minutos. Su ubicación sigue registrándose.`}
                        </p>
                        <button
                          onClick={() => {
                            setCameraTipo('almuerzo_fin');
                            setIsCameraOpen(true);
                          }}
                          disabled={actionLoading}
                          className="btn-primary mt-2.5 w-full py-3 text-base"
                        >
                          <ScanFace className="h-5 w-5" />
                          Terminar almuerzo
                        </button>
                      </div>
                    );
                  })()}

                  <button
                    onClick={() => iniciarMarcacion('salida')}
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

                  {almuerzo && !almuerzo.enAlmuerzo && !turnoEnOtroDispositivo && (
                    almuerzo.realizados < almuerzo.maximo ? (
                      <button
                        onClick={() => {
                          setCameraTipo('almuerzo_inicio');
                          setIsCameraOpen(true);
                        }}
                        disabled={actionLoading}
                        className="btn-secondary w-full py-3 text-base"
                      >
                        <ScanFace className="h-5 w-5" />
                        Iniciar almuerzo
                      </button>
                    ) : (
                      <p className="text-center text-sm text-slate-600">Su almuerzo de este turno ya fue registrado.</p>
                    )
                  )}
                </div>
              ) : (
                <button
                  onClick={() => iniciarMarcacion('entrada')}
                  disabled={actionLoading || gpsBuscando}
                  className="btn-primary w-full py-3.5 text-base"
                >
                  {actionLoading ? (
                    <RefreshCw className="h-5 w-5 animate-spin" />
                  ) : gpsBuscando ? (
                    <>
                      <RefreshCw className="h-5 w-5 animate-spin" />
                      {gpsMensaje}
                    </>
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
              <ShieldCheck
                className={`h-4 w-4 flex-shrink-0 ${
                  isActiveShift && turnoEnOtroDispositivo ? 'text-amber-700' : isActiveShift ? 'text-green-700' : 'text-slate-500'
                }`}
              />
              <span
                className={isActiveShift && turnoEnOtroDispositivo ? 'text-amber-800' : isActiveShift ? 'text-green-800' : 'text-slate-600'}
              >
                {isActiveShift && turnoEnOtroDispositivo
                  ? 'GPS en pausa: su turno está activo en otro dispositivo.'
                  : isActiveShift
                  ? 'GPS activo: su ubicación se envía durante el turno.'
                  : 'GPS inactivo: su ubicación no se comparte fuera del turno.'}
              </span>
            </div>
          </section>

          {/* Estación y ubicación (solo con turno activo) */}
          {isActiveShift && (
            <div className="space-y-4">
              {gpsImprecisa !== null && (
                <section className="panel border-l-4 border-l-red-700 p-4">
                  <h3 className="text-sm font-semibold text-red-800">Señal GPS imprecisa (±{gpsImprecisa} m)</h3>
                  <p className="mt-0.5 text-sm text-slate-700">
                    Su ubicación no se está registrando. Salga a un lugar abierto o active la ubicación de alta precisión
                    en su celular.
                  </p>
                </section>
              )}

              {turnoEnOtroDispositivo ? (
                <section className="panel border-l-4 border-l-amber-600 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">Su turno está activo en otro dispositivo</h3>
                  <p className="mt-0.5 text-sm text-slate-600">
                    Este teléfono no registra su ubicación: solo lo hace el dispositivo donde marcó la entrada. Para continuar
                    aquí, registre su salida en el otro dispositivo y vuelva a marcar su entrada en este. Si ya no tiene el
                    otro dispositivo, también puede registrar la salida desde aquí.
                  </p>
                </section>
              ) : esAppNativa ? (
                <section
                  className={`panel border-l-4 p-4 ${
                    errorNativo || (estadoNativo && !estadoNativo.servicioCorriendo) ? 'border-l-red-700' : 'border-l-green-700'
                  }`}
                >
                  {errorNativo || (estadoNativo && !estadoNativo.servicioCorriendo) ? (
                    <>
                      <h3 className="text-sm font-semibold text-red-800">El rastreo en segundo plano no está activo</h3>
                      <p className="mt-0.5 text-sm text-slate-700">
                        {errorNativo || estadoNativo?.ultimoError || 'Su ubicación no se está registrando.'}
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm mt-2"
                        onClick={() => selectedUser && startContinuousTracking(selectedUser.id)}
                      >
                        Reintentar
                      </button>
                    </>
                  ) : (
                    <>
                      <h3 className="text-sm font-semibold text-slate-900">Rastreo activo en segundo plano</h3>
                      <p className="mt-0.5 text-sm text-slate-600">
                        Su ubicación se registra durante el turno aunque apague la pantalla o cierre esta aplicación. No
                        desinstale ni detenga la aplicación hasta registrar su salida.
                        {estadoNativo && estadoNativo.pendientes > 3
                          ? ` Sin conexión: ${estadoNativo.pendientes} puntos pendientes de enviar.`
                          : ''}
                      </p>
                    </>
                  )}
                </section>
              ) : (
              <section className="panel border-l-4 border-l-amber-600 p-4">
                <h3 className="text-sm font-semibold text-slate-900">Mantenga esta aplicación abierta</h3>
                <p className="mt-0.5 text-sm text-slate-600">
                  Para que su ubicación se actualice, deje esta pantalla abierta y encendida
                  {wakeLockActivo ? ' (la pantalla no se apagará sola mientras esta aplicación esté abierta)' : ''}. Si bloquea
                  el teléfono o cambia de aplicación, el seguimiento se detiene.
                </p>
              </section>
              )}

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
              handleCheckInWithPhoto(result.photoBase64, result.similarity);
            } else if (cameraTipo === 'salida') {
              handleCheckOutWithPhoto(result.photoBase64, result.similarity, result.isVerified);
            } else {
              handleAlmuerzoConFoto(cameraTipo, result.photoBase64);
            }
          }}
        />
      )}

      {/* App Android: guía de permisos del rastreo en segundo plano */}
      {esAppNativa && permisosAbierto && (
        <NativePermissionsModal
          onCancelar={() => setPermisosAbierto(false)}
          onListo={() => {
            setPermisosAbierto(false);
            continuarMarcacion('entrada');
          }}
        />
      )}
    </div>
  );
};
