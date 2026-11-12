import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, auth } from '../services/api';
import { socket, connectSocket, disconnectSocket } from '../services/socket';
import { LiveMap } from '../components/LiveMap';
import { GoogleLiveMap } from '../components/GoogleLiveMap';
import { EnrolFaceModal } from '../components/EnrolFaceModal';
import { AuthLayout } from '../components/AuthLayout';
import { BrandLogo } from '../components/BrandLogo';
import { AuthImage } from '../components/AuthImage';
import type {
  EstacionTrabajo,
  ResumenDashboard,
  DatosTrabajadorEnVivo,
  RegistroAsistencia,
  Usuario,
  AuditoriaFraudeFacial,
} from '../types';
import {
  MapPin,
  ShieldCheck,
  Download,
  Search,
  Plus,
  Layers,
  LogOut,
  X,
  Link,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';

// Fechas locales en formato AAAA-MM-DD (lo que usan los <input type="date">)
const toInputDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const LOGS_PAGE_SIZE = 50;

// Nombre legible de los tipos de evento de la auditoría
const etiquetaEvento = (tipo: string) =>
  ({ SUPLANTACION_ROSTRO: 'Suplantación de rostro', FALLA_PRUEBA_VIDA: 'Falla en la prueba de vida' } as Record<string, string>)[tipo] ||
  tipo.charAt(0) + tipo.slice(1).toLowerCase().replace(/_/g, ' ');

// Mensajes rápidos para las alertas al celular del trabajador
const ALERT_PRESETS = [
  'Se encuentra fuera de su zona de trabajo. Regrese a su estación asignada.',
  'Por favor, comuníquese con su supervisor lo antes posible.',
  'Recuerde registrar su salida al terminar su turno.',
];

// Formatea milisegundos como HH:MM:SS (las horas pueden pasar de 24)
const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// Contador en vivo del tiempo que lleva un trabajador en turno.
// offsetMs corrige la diferencia entre el reloj de este equipo y el del servidor.
const ElapsedTimer: React.FC<{ since: string; offsetMs: number }> = ({ since, offsetMs }) => {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono font-bold text-sm text-blue-700 tabular-nums">
      {formatElapsed(now + offsetMs - new Date(since).getTime())}
    </span>
  );
};

export const AdminPage: React.FC = () => {
  // Authentication state for admin
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(() => Boolean(auth.getToken()));
  const [adminCode, setAdminCode] = useState<string>('');
  const [adminPin, setAdminPin] = useState<string>('');
  const [adminLoginLoading, setAdminLoginLoading] = useState<boolean>(false);

  // Core data from SQL Server
  const [workstations, setWorkstations] = useState<EstacionTrabajo[]>([]);
  const [attendanceLogs, setAttendanceLogs] = useState<RegistroAsistencia[]>([]);
  const [liveWorkers, setLiveWorkers] = useState<DatosTrabajadorEnVivo[]>([]);
  // Historial de asistencia: filtro por fechas, búsqueda en el servidor y paginación
  const [logsDesde, setLogsDesde] = useState<string>(() => toInputDate(daysAgo(6)));
  const [logsHasta, setLogsHasta] = useState<string>(() => toInputDate(new Date()));
  const [logsPage, setLogsPage] = useState<number>(0);
  const [logsTotal, setLogsTotal] = useState<number>(0);
  const [logsSearch, setLogsSearch] = useState<string>('');
  const [exporting, setExporting] = useState<boolean>(false);

  // Alertas push al celular del trabajador
  const [alertTarget, setAlertTarget] = useState<DatosTrabajadorEnVivo | null>(null);
  const [alertMsg, setAlertMsg] = useState<string>('');
  const [alertSending, setAlertSending] = useState<boolean>(false);
  const [clockOffsetMs, setClockOffsetMs] = useState<number>(0); // reloj del servidor - reloj de este equipo
  const [workersList, setWorkersList] = useState<Usuario[]>([]);
  const [fraudLogs, setFraudLogs] = useState<AuditoriaFraudeFacial[]>([]);
  const [summary, setSummary] = useState<ResumenDashboard>({
    totalTrabajadores: 0,
    activosConteo: 0,
    dentroEstacionConteo: 0,
    fueraEstacionConteo: 0,
  });

  const [loading, setLoading] = useState<boolean>(true);
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(socket.connected);
  const [recentNotification, setRecentNotification] = useState<{ texto: string; fecha: string } | null>(null);

  // Modal para ver foto de evidencia en tamaño completo y comparación biométrica
  const [photoPreview, setPhotoPreview] = useState<{
    url: string;
    workerName?: string;
    type: 'entrada' | 'salida';
    date?: string | null;
    stationName?: string | null;
    referencePhotoUrl?: string | null;
    similarity?: number | null;
  } | null>(null);

  // Modal para enrolar rostro de trabajador
  const [selectedWorkerForEnrol, setSelectedWorkerForEnrol] = useState<Usuario | null>(null);
  const [showEnrolModal, setShowEnrolModal] = useState<boolean>(false);

  // Tabs & filters
  const [activeTab, setActiveTab] = useState<'map' | 'logs' | 'workers' | 'fraud' | 'stations'>('map');
  const [mapProvider, setMapProvider] = useState<'google' | 'leaflet'>('google');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedWorker, setSelectedWorker] = useState<DatosTrabajadorEnVivo | null>(null);

  // New Workstation Modal state
  const [showNewStationModal, setShowNewStationModal] = useState<boolean>(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newLat, setNewLat] = useState('-12.0463');
  const [newLng, setNewLng] = useState('-77.0427');
  const [newRadius, setNewRadius] = useState('50');
  const [newColor, setNewColor] = useState('#3B82F6');
  const [isSavingStation, setIsSavingStation] = useState(false);

  // New Worker Modal state
  const [showNewWorkerModal, setShowNewWorkerModal] = useState<boolean>(false);
  const [newWorkerCode, setNewWorkerCode] = useState<string>('');
  const [newWorkerName, setNewWorkerName] = useState<string>('');
  const [newWorkerCargo, setNewWorkerCargo] = useState<string>('Operador de Campo');
  const [newWorkerPhone, setNewWorkerPhone] = useState<string>('');
  const [newWorkerPin, setNewWorkerPin] = useState<string>('');
  const [isSavingWorker, setIsSavingWorker] = useState<boolean>(false);

  // Link de Google Maps parser state
  const [mapsUrlInput, setMapsUrlInput] = useState<string>('');
  const [isParsingUrl, setIsParsingUrl] = useState<boolean>(false);
  const [parseStatus, setParseStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Extraer coordenadas de link de Google Maps
  const handleExtractFromMapsUrl = async (urlToParse?: string) => {
    const url = (urlToParse !== undefined ? urlToParse : mapsUrlInput).trim();
    if (!url) {
      setParseStatus({ type: 'error', message: 'Pega un enlace de Google Maps primero.' });
      return;
    }

    setIsParsingUrl(true);
    setParseStatus(null);

    // 1. Extracción local rápida por Regex
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const qMatch = url.match(/[?&]q=(-?\d+\.\d+)[,%2C]+(-?\d+\.\d+)/i);
    const dataMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);

    if (atMatch) {
      const lat = parseFloat(atMatch[1]);
      const lng = parseFloat(atMatch[2]);
      setNewLat(lat.toFixed(6));
      setNewLng(lng.toFixed(6));
      setParseStatus({ type: 'success', message: `Coordenadas detectadas: ${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      setIsParsingUrl(false);
      return;
    } else if (qMatch) {
      const lat = parseFloat(qMatch[1]);
      const lng = parseFloat(qMatch[2]);
      setNewLat(lat.toFixed(6));
      setNewLng(lng.toFixed(6));
      setParseStatus({ type: 'success', message: `Coordenadas detectadas: ${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      setIsParsingUrl(false);
      return;
    } else if (dataMatch) {
      const lat = parseFloat(dataMatch[1]);
      const lng = parseFloat(dataMatch[2]);
      setNewLat(lat.toFixed(6));
      setNewLng(lng.toFixed(6));
      setParseStatus({ type: 'success', message: `Coordenadas detectadas: ${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      setIsParsingUrl(false);
      return;
    }

    // 2. Si es enlace corto (ej: maps.app.goo.gl) o necesita resolver redirección en backend
    try {
      const data = await api.parseGoogleMapsUrl(url);
      setNewLat(data.latitud.toFixed(6));
      setNewLng(data.longitud.toFixed(6));
      if (data.nombreSugerido && !newName) {
        setNewName(data.nombreSugerido);
      }
      setParseStatus({
        type: 'success',
        message: `¡Coordenadas extraídas con éxito! (${data.latitud.toFixed(4)}, ${data.longitud.toFixed(4)})${
          data.nombreSugerido ? ` - ${data.nombreSugerido}` : ''
        }`,
      });
    } catch (err: any) {
      setParseStatus({
        type: 'error',
        message: err.message || 'No se pudieron extraer las coordenadas del enlace de Maps.',
      });
    } finally {
      setIsParsingUrl(false);
    }
  };

  // --- Carga de datos ---------------------------------------------------------------------------
  // Antes TODO (historial con fotos incluido) se pedía cada 3 s y en cada evento: con 30 marcas casi
  // simultáneas eso saturaba el servidor. Ahora:
  //   - Estado en vivo (liviano): cada 3 s.
  //   - Listados completos (estaciones, historial, usuarios, alertas): cada 30 s, y agrupados en una sola
  //     recarga cuando llegan eventos (un lote de 30 marcas = 1 recarga, no 30).
  //   - Las fotos ya no viajan en los listados: se piden una por una al verlas.
  const liveWorkersRef = useRef<DatosTrabajadorEnVivo[]>([]);
  liveWorkersRef.current = liveWorkers;
  const liveInFlight = useRef<boolean>(false);
  const heavyInFlight = useRef<boolean>(false);
  const heavyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLive = useCallback(async () => {
    if (liveInFlight.current) return; // no apilar peticiones si la red va lenta
    liveInFlight.current = true;
    try {
      const liveData = await api.getLiveDashboard();
      setLiveWorkers(liveData.trabajadores);
      setSummary(liveData.resumen);
      if (liveData.ahora) setClockOffsetMs(new Date(liveData.ahora).getTime() - Date.now());
    } catch (err) {
      console.error('Error cargando estado en vivo:', err);
    } finally {
      liveInFlight.current = false;
      setLoading(false);
    }
  }, []);

  const loadHeavy = useCallback(async () => {
    if (heavyInFlight.current) return;
    heavyInFlight.current = true;
    try {
      const [stationsData, usersData, fraudData] = await Promise.all([
        api.getWorkstations(),
        api.getUsers(),
        api.getFraudLogs(),
      ]);
      setWorkstations(stationsData);
      setWorkersList(usersData);
      setFraudLogs(fraudData);
    } catch (err) {
      console.error('Error cargando listados del panel admin:', err);
    } finally {
      heavyInFlight.current = false;
      setLoading(false);
    }
  }, []);

  // Parámetros del historial según los filtros elegidos (las fechas se interpretan en hora local)
  const logsParams = useCallback(() => {
    const desde = logsDesde ? new Date(`${logsDesde}T00:00:00`).toISOString() : undefined;
    let hasta: string | undefined;
    if (logsHasta) {
      const d = new Date(`${logsHasta}T00:00:00`);
      d.setDate(d.getDate() + 1); // "hasta" incluye todo ese día
      hasta = d.toISOString();
    }
    return { desde, hasta, q: logsSearch || undefined };
  }, [logsDesde, logsHasta, logsSearch]);

  // Historial de asistencia: solo la página que se está viendo
  const loadLogs = useCallback(async () => {
    try {
      const { items, total } = await api.getAttendanceLogs({
        ...logsParams(),
        limit: LOGS_PAGE_SIZE,
        offset: logsPage * LOGS_PAGE_SIZE,
      });
      setAttendanceLogs(items);
      setLogsTotal(total);
    } catch (err) {
      console.error('Error cargando el historial de asistencia:', err);
    }
  }, [logsParams, logsPage]);
  const loadLogsRef = useRef(loadLogs);
  loadLogsRef.current = loadLogs;

  // Listados completos + historial (siempre con los filtros actuales)
  const refreshLists = useCallback(() => {
    loadHeavy();
    loadLogsRef.current();
  }, [loadHeavy]);

  // Agrupa muchas notificaciones seguidas en una sola recarga de listados
  const scheduleHeavyReload = useCallback(() => {
    if (heavyTimer.current) clearTimeout(heavyTimer.current);
    heavyTimer.current = setTimeout(() => {
      heavyTimer.current = null;
      refreshLists();
    }, 1500);
  }, [refreshLists]);

  // Recarga completa (tras crear/editar algo desde el panel)
  const loadData = useCallback(async () => {
    await Promise.all([loadLive(), loadHeavy(), loadLogs()]);
  }, [loadLive, loadHeavy, loadLogs]);

  // El historial se recarga solo cuando cambian el rango de fechas, la búsqueda o la página
  useEffect(() => {
    if (isAdminAuthenticated) loadLogs();
  }, [isAdminAuthenticated, loadLogs]);

  // La búsqueda se envía al servidor con una pequeña espera para no pedir en cada tecla
  useEffect(() => {
    const t = setTimeout(() => {
      setLogsSearch(searchTerm.trim());
      setLogsPage(0);
    }, 400);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Si el total baja (p. ej. al filtrar) y la página queda fuera de rango, volver a la última válida
  useEffect(() => {
    if (logsPage > 0 && logsPage * LOGS_PAGE_SIZE >= logsTotal) {
      setLogsPage(Math.max(0, Math.ceil(logsTotal / LOGS_PAGE_SIZE) - 1));
    }
  }, [logsTotal, logsPage]);

  useEffect(() => {
    if (!isAdminAuthenticated) return;

    // Asegurar que el socket esté conectado (usa el token de la sesión)
    connectSocket();

    loadLive();
    loadHeavy();

    // Sincronización de respaldo: estado en vivo cada 3 s (liviano) y listados completos cada 30 s
    const syncInterval = setInterval(() => {
      loadLive();
    }, 3000);
    const heavyInterval = setInterval(() => {
      refreshLists();
    }, 30000);

    const onConnect = () => {
      console.log('Socket conectado al panel admin');
      setIsSocketConnected(true);
    };
    const onDisconnect = () => {
      console.warn('Socket desconectado del panel admin');
      setIsSocketConnected(false);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Evento de Telemetría GPS en tiempo real
    socket.on('location_ping', (data: any) => {
      console.log('Telemetría recibida en vivo:', data);
      setLiveWorkers((prev) =>
        prev.map((worker) => {
          if (worker.usuario_id === data.usuarioId) {
            return {
              ...worker,
              latitud: data.latitud,
              longitud: data.longitud,
              precision: data.precision,
              dentro_de_estacion: data.dentroDeEstacion,
              estacion_nombre: data.estacion ? data.estacion.nombre : null,
              estacion_codigo: data.estacion ? data.estacion.codigo : null,
              estacion_color: data.estacion ? data.estacion.color : null,
              ultimo_ping: data.fecha,
            };
          }
          return worker;
        })
      );
    });

    // Evento de Registro de Asistencia (Entrada / Salida)
    socket.on('attendance_event', (eventData: any) => {
      console.log('Evento de asistencia recibido en socket:', eventData);
      loadLive();
      scheduleHeavyReload();

      const ahora = new Date().toLocaleTimeString();
      if (eventData?.tipo === 'CHECK_IN') {
        setRecentNotification({
          texto: `Entrada registrada en tiempo real (${ahora})`,
          fecha: ahora,
        });
      } else if (eventData?.tipo === 'CHECK_OUT') {
        setRecentNotification({
          texto: `Salida registrada. GPS detenido (${ahora})`,
          fecha: ahora,
        });
      }
    });

    // Evento de Alerta de Fraude Facial
    socket.on('fraud_alert', (fraudEvent: any) => {
      console.warn('Alerta de fraude facial recibida:', fraudEvent);
      scheduleHeavyReload();
      const ahora = new Date().toLocaleTimeString();
      setRecentNotification({
        texto: `ALERTA: Intento de suplantación facial detectado (${
          fraudEvent?.similitudObtenida ? Math.round(fraudEvent.similitudObtenida) + '%' : 'No coincide'
        }) a las ${ahora}`,
        fecha: ahora,
      });
    });

    // El trabajador abrió/leyó la alerta que se le envió
    socket.on('alerta_leida', (d: any) => {
      const nombre = liveWorkersRef.current.find((w) => w.usuario_id === d?.usuarioId)?.nombre_usuario || 'El trabajador';
      const hora = new Date().toLocaleTimeString();
      setRecentNotification({ texto: `${nombre} leyó la alerta (${hora})`, fecha: hora });
    });

    // Evento de Enrolamiento Facial
    socket.on('user_face_enrolled', (data: any) => {
      console.log('Rostro enrolado en tiempo real:', data);
      scheduleHeavyReload();
    });

    socket.on('workstations_updated', (newStation: EstacionTrabajo) => {
      setWorkstations((prev) => [...prev, newStation]);
    });

    return () => {
      clearInterval(syncInterval);
      clearInterval(heavyInterval);
      if (heavyTimer.current) clearTimeout(heavyTimer.current);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('location_ping');
      socket.off('attendance_event');
      socket.off('fraud_alert');
      socket.off('user_face_enrolled');
      socket.off('alerta_leida');
      socket.off('workstations_updated');
    };
  }, [isAdminAuthenticated, loadLive, loadHeavy, refreshLists, scheduleHeavyReload]);

  // Envía la alerta al celular del trabajador (llega aunque tenga la pantalla apagada)
  const handleSendAlert = async () => {
    if (!alertTarget || alertSending) return;
    setAlertSending(true);
    try {
      const r = await api.sendAlert(alertTarget.usuario_id, alertMsg.trim());
      const hora = new Date().toLocaleTimeString();
      let texto: string;
      if (r.dispositivos === 0 && !r.appAbierta) {
        texto = `${r.trabajador} no tiene las alertas activadas en su celular: solo la verá si abre la app (${hora})`;
      } else if (r.dispositivos > 0 && r.entregadosAlServicioPush === 0 && !r.appAbierta) {
        texto = `No se pudo entregar la alerta a ${r.trabajador}: su celular no respondió (${hora})`;
      } else {
        texto = `Alerta enviada a ${r.trabajador}${r.appAbierta ? ' (tiene la app abierta)' : ''} (${hora})`;
      }
      setRecentNotification({ texto, fecha: hora });
      setAlertTarget(null);
      setAlertMsg('');
    } catch (err: any) {
      alert(err.message || 'No se pudo enviar la alerta');
    } finally {
      setAlertSending(false);
    }
  };

  // Ingreso de administrador: el servidor valida código + clave (con límite de intentos)
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adminLoginLoading) return;
    setAdminLoginLoading(true);
    try {
      await api.adminLogin(adminCode.trim(), adminPin);
      setAdminPin('');
      setIsAdminAuthenticated(true);
    } catch (err: any) {
      setAdminPin('');
      alert(err.message || 'No se pudo iniciar sesión');
    } finally {
      setAdminLoginLoading(false);
    }
  };

  const handleAdminLogout = () => {
    api.logout();
    disconnectSocket();
    setIsAdminAuthenticated(false);
  };

  // Si el servidor responde 401 (sesión vencida), volver al formulario de ingreso
  useEffect(() => {
    const onUnauthorized = () => {
      disconnectSocket();
      setIsAdminAuthenticated(false);
    };
    window.addEventListener('smi:unauthorized', onUnauthorized);
    return () => window.removeEventListener('smi:unauthorized', onUnauthorized);
  }, []);

  // Con una sesión guardada, confirmar que de verdad es de administrador/supervisor
  useEffect(() => {
    if (!isAdminAuthenticated) return;
    api
      .getMe()
      .then((me) => {
        if (me.rol !== 'administrador' && me.rol !== 'supervisor') {
          api.logout();
          disconnectSocket();
          setIsAdminAuthenticated(false);
        }
      })
      .catch(() => {
        /* si la sesión venció, el listener de 401 vuelve al formulario */
      });
  }, [isAdminAuthenticated]);

  // Filter active workers for map
  const activeWorkers = liveWorkers.filter((w) => w.estado_asistencia === 'activo');

  // Filter lists
  const filteredWorkers = liveWorkers.filter(
    (w) =>
      w.nombre_usuario.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.codigo_empleado.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.cargo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // El historial ya llega filtrado y paginado desde el servidor (fechas + búsqueda)
  const filteredLogs = attendanceLogs;

  const filteredWorkersList = workersList.filter(
    (w) =>
      w.nombre.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.codigo_empleado.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.cargo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredFraudLogs = fraudLogs.filter(
    (f) =>
      (f.nombre_usuario || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (f.codigo_empleado || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (f.tipo_evento || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Exporta TODO el rango filtrado (no solo la página visible), pidiéndolo al servidor por tandas
  const handleExportCSV = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const PAGE = 1000;
      const MAX = 50000;
      const todos: RegistroAsistencia[] = [];
      for (let offset = 0; offset < MAX; offset += PAGE) {
        const { items, total } = await api.getAttendanceLogs({ ...logsParams(), limit: PAGE, offset });
        todos.push(...items);
        if (todos.length >= total || items.length < PAGE) break;
      }
      if (todos.length === 0) {
        alert('No hay registros para exportar en este rango');
        return;
      }

      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const headers = [
        'ID', 'Código Empleado', 'Trabajador', 'Cargo', 'Hora Ingreso', 'Estación Ingreso', 'Hora Salida',
        'Estación Salida', 'Horas Totales', 'Similitud Facial', 'Biometría Exitosa', 'Método Validación', 'Estado',
      ];
      const rows = todos.map((log) => [
        log.id,
        q(log.codigo_empleado),
        q(log.nombre_usuario),
        q(log.cargo),
        q(log.hora_ingreso ? new Date(log.hora_ingreso).toLocaleString() : ''),
        q(log.estacion_ingreso_nombre || 'Fuera de estación'),
        q(log.hora_salida ? new Date(log.hora_salida).toLocaleString() : 'En curso'),
        q(log.estacion_salida_nombre),
        log.horas_totales ?? '',
        log.similitud_facial !== null && log.similitud_facial !== undefined ? `${Math.round(log.similitud_facial)}%` : '',
        log.verificacion_facial_exitosa ? 'SI' : 'NO',
        q(log.metodo_validacion || 'facial_biometrico'),
        log.estado,
      ]);

      const csv = '\uFEFF' + [headers.map(q).join(','), ...rows.map((r) => r.join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `SMI_Asistencia_${logsDesde || 'inicio'}_${logsHasta || 'hoy'}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || 'No se pudo exportar el historial');
    } finally {
      setExporting(false);
    }
  };

  // Create Workstation
  const handleCreateStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCode || !newName || !newLat || !newLng) {
      alert('Completa los campos obligatorios');
      return;
    }
    setIsSavingStation(true);
    try {
      await api.createWorkstation({
        codigo: newCode,
        nombre: newName,
        latitud: parseFloat(newLat),
        longitud: parseFloat(newLng),
        radio_metros: parseFloat(newRadius) || 50,
        color: newColor,
      });
      setShowNewStationModal(false);
      setNewCode('');
      setNewName('');
      setMapsUrlInput('');
      setParseStatus(null);
      loadData();
    } catch (err: any) {
      alert(err.message || 'Error al guardar la estación');
    } finally {
      setIsSavingStation(false);
    }
  };

  // Create Worker
  const handleCreateWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWorkerCode || !newWorkerName) {
      alert('Código y nombre son obligatorios');
      return;
    }
    setIsSavingWorker(true);
    try {
      const created = await api.createUser({
        codigo_empleado: newWorkerCode.trim(),
        nombre: newWorkerName.trim(),
        cargo: newWorkerCargo.trim() || 'Operador de Campo',
        telefono: newWorkerPhone.trim(),
        pin: newWorkerPin.trim() || undefined,
        rol: 'trabajador',
      });
      setShowNewWorkerModal(false);
      setNewWorkerCode('');
      setNewWorkerName('');
      setNewWorkerCargo('Operador de Campo');
      setNewWorkerPhone('');
      setNewWorkerPin('');
      loadData();
      alert(`¡Trabajador registrado con éxito!\n\nPIN de acceso: ${created.pinInicial}\n(Entrégaselo ahora: no se vuelve a mostrar.)\n\nAl ingresar por primera vez podrá enrolar su rostro.`);
    } catch (err: any) {
      alert(err.message || 'Error al crear trabajador');
    } finally {
      setIsSavingWorker(false);
    }
  };

  // Reset Worker Face Biometrics
  const handleResetFace = async (workerId: number, workerName: string) => {
    const confirm = window.confirm(
      `¿Deseas resetear la biometría facial de ${workerName}? El trabajador podrá auto-enrolar su nuevo rostro en su próxima marcación.`
    );
    if (!confirm) return;

    try {
      await api.resetUserFace(workerId);
      loadData();
      alert(`Biometría de ${workerName} reseteada exitosamente. En su próxima marcación se auto-enrolará.`);
    } catch (err: any) {
      alert(err.message || 'Error al resetear biometría');
    }
  };

  // Pantalla de ingreso
  if (!isAdminAuthenticated) {
    return (
      <AuthLayout
        titulo="Acceso al panel"
        subtitulo="Ingrese con su código de usuario y su clave."
        panelTitulo="Panel de control"
        panelTexto="Supervise en tiempo real al personal en turno, revise el historial de asistencia y administre estaciones y datos biométricos."
      >
        <form onSubmit={handleAdminLogin} className="space-y-5">
          <div>
            <label htmlFor="codigo" className="field-label">
              Código de usuario
            </label>
            <input
              id="codigo"
              type="text"
              value={adminCode}
              onChange={(e) => setAdminCode(e.target.value)}
              placeholder="Ej.: ADM-001"
              autoComplete="username"
              className="field"
            />
          </div>
          <div>
            <label htmlFor="clave" className="field-label">
              Clave
            </label>
            <input
              id="clave"
              type="password"
              value={adminPin}
              onChange={(e) => setAdminPin(e.target.value)}
              placeholder="Ingrese su clave"
              autoComplete="current-password"
              className="field"
            />
          </div>
          <button
            type="submit"
            disabled={adminLoginLoading || !adminCode.trim() || !adminPin}
            className="btn-primary w-full"
          >
            {adminLoginLoading ? 'Verificando…' : 'Ingresar'}
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-100">
      {/* Encabezado institucional */}
      <header className="sticky top-0 z-50 bg-brand-600 text-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <BrandLogo variant="blanco" className="h-10 w-auto" />
            <div className="hidden border-l border-white/30 pl-4 sm:block">
              <p className="text-base font-semibold leading-tight">Panel de control</p>
              <p className="text-sm leading-tight text-brand-100">Monitoreo de asistencia y geocercas</p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <span className="hidden items-center gap-2 text-brand-100 sm:flex">
              <span className={`h-2 w-2 ${isSocketConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              {isSocketConnected ? 'Conectado en vivo' : 'Sin conexión'}
            </span>
            <button
              onClick={handleAdminLogout}
              className="inline-flex items-center gap-2 rounded border border-white/40 px-3 py-1.5 font-medium transition-colors hover:bg-white/10"
            >
              <LogOut className="h-4 w-4" />
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>

      {/* Contenido */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
            <p className="text-sm text-slate-600">Conectando con la base de datos…</p>
          </div>
        ) : (
          <>
            {/* Aviso en tiempo real (entradas, salidas, alertas) */}
            {recentNotification && (
              <div className="mb-4 flex items-center justify-between gap-4 border border-slate-300 border-l-4 border-l-brand-600 bg-white px-4 py-3 text-sm text-slate-800">
                <span>{recentNotification.texto}</span>
                <button
                  onClick={() => setRecentNotification(null)}
                  className="flex-shrink-0 font-medium text-brand-700 hover:underline"
                >
                  Cerrar
                </button>
              </div>
            )}

            {/* Indicadores */}
            <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                { label: 'Personal total', value: summary.totalTrabajadores, accent: 'border-t-slate-400', color: 'text-slate-900' },
                { label: 'En turno', value: summary.activosConteo, accent: 'border-t-brand-600', color: 'text-brand-700' },
                { label: 'En su estación', value: summary.dentroEstacionConteo, accent: 'border-t-green-700', color: 'text-green-800' },
                { label: 'Fuera de zona o en tránsito', value: summary.fueraEstacionConteo, accent: 'border-t-amber-600', color: 'text-amber-800' },
              ].map((s) => (
                <div key={s.label} className={`panel border-t-4 p-4 ${s.accent}`}>
                  <p className="text-sm text-slate-600">{s.label}</p>
                  <p className={`mt-1 text-3xl font-semibold tabular-nums ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* Pestañas */}
            <nav className="mb-4 flex overflow-x-auto border-b border-slate-300 sm:flex-wrap">
              {(
                [
                  { id: 'map', label: 'Mapa en tiempo real' },
                  { id: 'logs', label: `Historial de asistencia (${logsTotal})` },
                  { id: 'workers', label: `Personal y biometría (${workersList.length})` },
                  { id: 'fraud', label: 'Alertas de fraude', badge: fraudLogs.length },
                  { id: 'stations', label: `Estaciones (${workstations.length})` },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`-mb-px flex flex-shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === t.id
                      ? 'border-brand-600 text-brand-700'
                      : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                  }`}
                >
                  {t.label}
                  {'badge' in t && t.badge > 0 && (
                    <span className="min-w-5 bg-red-700 px-1.5 text-center text-xs font-semibold text-white">{t.badge}</span>
                  )}
                </button>
              ))}
            </nav>

            {/* Búsqueda y acciones de la pestaña */}
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              {activeTab !== 'stations' ? (
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Buscar trabajador o código"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="field py-2 pl-9"
                />
              </div>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-2">
                {activeTab === 'logs' && (
                  <button onClick={handleExportCSV} disabled={exporting} className="btn-secondary whitespace-nowrap">
                    <Download className="h-4 w-4" />
                    {exporting ? 'Exportando…' : 'Exportar CSV'}
                  </button>
                )}

                {activeTab === 'stations' && (
                  <button onClick={() => setShowNewStationModal(true)} className="btn-primary whitespace-nowrap">
                    <Plus className="h-4 w-4" />
                    Nueva estación
                  </button>
                )}
              </div>
            </div>

            {/* Tab 1: Live Interactive Map */}
            {activeTab === 'map' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 flex flex-col space-y-2">
                  {/* Selector de Motor de Mapa */}
                  <div className="flex items-center justify-between bg-white px-3 py-1.5 rounded-xl border border-slate-200 shadow-sm text-xs">
                    <span className="font-bold text-slate-700 flex items-center">
                      <Layers className="w-3.5 h-3.5 mr-1 text-blue-600" />
                      Motor Cartográfico:
                    </span>
                    <div className="flex items-center space-x-1 bg-slate-100 p-0.5 rounded-lg">
                      <button
                        onClick={() => setMapProvider('google')}
                        className={`px-3 py-1 rounded-md font-bold text-xs transition cursor-pointer ${
 mapProvider === 'google'
 ? 'bg-blue-600 text-white shadow-sm'
 : 'text-slate-600 hover:text-slate-900'
 }`}
                      >
                        Google Maps Oficial
                      </button>
                      <button
                        onClick={() => setMapProvider('leaflet')}
                        className={`px-3 py-1 rounded-md font-semibold text-xs transition cursor-pointer ${
 mapProvider === 'leaflet'
 ? 'bg-blue-600 text-white shadow-sm'
 : 'text-slate-600 hover:text-slate-900'
 }`}
                      >
                        OpenStreetMap
                      </button>
                    </div>
                  </div>

                  {/* Renderizado de Mapa según motor */}
                  {mapProvider === 'google' ? (
                    <GoogleLiveMap
                      workstations={workstations}
                      activeWorkers={activeWorkers}
                      selectedWorker={selectedWorker}
                      onSelectWorker={(w) => setSelectedWorker(w)}
                      onMapClick={(lat, lng) => {
                        setNewLat(lat.toFixed(6));
                        setNewLng(lng.toFixed(6));
                        setShowNewStationModal(true);
                      }}
                    />
                  ) : (
                    <LiveMap
                      workstations={workstations}
                      activeWorkers={activeWorkers}
                      selectedWorker={selectedWorker}
                      onSelectWorker={(w) => setSelectedWorker(w)}
                    />
                  )}
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col h-[550px]">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                    <h3 className="font-bold text-sm text-slate-800">
                      Personal en Turno ({activeWorkers.length})
                    </h3>
                    
                  </div>

                  <div className="flex-1 overflow-y-auto divide-y divide-slate-100 mt-2 pr-1 space-y-2">
                    {filteredWorkers.length === 0 ? (
                      <p className="text-xs text-slate-400 text-center py-8">No se encontraron trabajadores</p>
                    ) : (
                      filteredWorkers.map((worker) => {
                        const isActive = worker.estado_asistencia === 'activo';
                        const isInside = worker.dentro_de_estacion;

                        return (
                          <div
                            key={worker.usuario_id}
                            onClick={() => setSelectedWorker(worker)}
                            className={`p-3 rounded-xl transition cursor-pointer ${
 selectedWorker?.usuario_id === worker.usuario_id
 ? 'bg-blue-50 border border-blue-200'
 : 'hover:bg-slate-50'
 }`}
                          >
                            <div className="flex items-start justify-between">
                              <div>
                                <div className="flex items-center space-x-2">
                                  <h4 className="font-bold text-xs text-slate-900">{worker.nombre_usuario}</h4>
                                  <span className="text-xs font-mono font-bold bg-slate-100 px-1.5 py-0.2 rounded text-slate-600">
                                    {worker.codigo_empleado}
                                  </span>
                                </div>
                                <p className="text-xs text-slate-500">{worker.cargo}</p>
                              </div>

                              {isActive ? (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-xs font-bold ${
 isInside
 ? 'bg-emerald-100 text-emerald-800'
 : 'bg-amber-100 text-amber-800'
 }`}
                                >
                                  {isInside ? 'En Estación' : 'Fuera de Zona'}
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-400">
                                  Inactivo
                                </span>
                              )}
                            </div>

                            {isActive && worker.hora_ingreso && (
                              <div className="mt-2 flex items-center justify-between bg-blue-50 border border-blue-100 rounded-lg px-2.5 py-1.5">
                                <div className="flex flex-col leading-tight">
                                  <span className="text-xs font-bold text-blue-600 uppercase tracking-wide">
                                    ⏱ Tiempo en turno
                                  </span>
                                  <span className="text-xs text-slate-500">
                                    Ingresó a las{' '}
                                    {new Date(worker.hora_ingreso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                                <ElapsedTimer since={worker.hora_ingreso} offsetMs={clockOffsetMs} />
                              </div>
                            )}

                            {isActive && (
                              <div className="mt-2 flex items-center justify-between gap-2">
                                <span
                                  className={`text-xs font-semibold ${
 worker.push_activo ? 'text-emerald-600' : 'text-slate-400'
 }`}
                                  title={
                                    worker.push_activo
                                      ? 'Este trabajador activó las alertas en su celular'
                                      : 'Todavía no activó las alertas: solo verá el mensaje si abre la app'
                                  }
                                >
                                  {worker.push_activo === undefined
                                    ? ''
                                    : worker.push_activo
                                    ? 'Alertas activadas'
                                    : 'Sin alertas activadas'}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAlertTarget(worker);
                                    setAlertMsg(isInside ? '' : ALERT_PRESETS[0]);
                                  }}
                                  className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition active:scale-95 ${
 isInside
 ? 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
 : 'bg-amber-500 text-white border-amber-600 hover:bg-amber-600 shadow-sm'
 }`}
                                >
                                  Enviar alerta
                                </button>
                              </div>
                            )}

                            {isActive && (
                              <div className="mt-2 text-xs text-slate-500 bg-white p-2 rounded-lg border border-slate-100 flex items-center justify-between">
                                <span className="font-medium text-slate-700">
                                  {worker.estacion_nombre ? `${worker.estacion_nombre}` : 'Sin estación fija'}
                                </span>
                                <span className="text-blue-600 font-semibold">
                                  ±{Math.round(worker.precision || 10)}m
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Tab 2: Attendance Logs Table */}
            {activeTab === 'logs' && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                {/* Filtro por fechas */}
                <div className="flex flex-wrap items-end gap-3 p-3 border-b border-slate-100 bg-slate-50/60">
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                    Desde
                    <input
                      type="date"
                      value={logsDesde}
                      max={logsHasta || undefined}
                      onChange={(e) => {
                        setLogsDesde(e.target.value);
                        setLogsPage(0);
                      }}
                      className="block mt-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                    Hasta
                    <input
                      type="date"
                      value={logsHasta}
                      min={logsDesde || undefined}
                      onChange={(e) => {
                        setLogsHasta(e.target.value);
                        setLogsPage(0);
                      }}
                      className="block mt-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: 'Hoy', dias: 0 },
                      { label: '7 días', dias: 6 },
                      { label: '30 días', dias: 29 },
                    ].map((r) => (
                      <button
                        key={r.label}
                        type="button"
                        onClick={() => {
                          setLogsDesde(toInputDate(daysAgo(r.dias)));
                          setLogsHasta(toInputDate(new Date()));
                          setLogsPage(0);
                        }}
                        className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 hover:bg-blue-600 hover:border-blue-600 hover:text-white text-slate-600 rounded-lg transition"
                      >
                        {r.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setLogsDesde('');
                        setLogsHasta('');
                        setLogsPage(0);
                      }}
                      className="px-2.5 py-1 text-xs font-bold bg-white border border-slate-300 hover:bg-blue-600 hover:border-blue-600 hover:text-white text-slate-600 rounded-lg transition"
                    >
                      Todo
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-600">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold text-xs tracking-wider">
                      <tr>
                        <th className="px-4 py-3">Código</th>
                        <th className="px-4 py-3">Trabajador</th>
                        <th className="px-4 py-3">Cargo</th>
                        <th className="px-4 py-3">Ingreso (GPS)</th>
                        <th className="px-4 py-3">Estación Ingreso</th>
                        <th className="px-4 py-3 text-center">Foto Entrada</th>
                        <th className="px-4 py-3">Salida (GPS)</th>
                        <th className="px-4 py-3">Estación Salida</th>
                        <th className="px-4 py-3 text-center">Foto Salida</th>
                        <th className="px-4 py-3 text-center">Biometría</th>
                        <th className="px-4 py-3 text-right">Horas</th>
                        <th className="px-4 py-3 text-center">Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredLogs.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-4 py-8 text-center text-slate-400">
                            No hay registros de asistencia en este rango.
                          </td>
                        </tr>
                      ) : (
                        filteredLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-slate-50 transition">
                            <td className="px-4 py-3 font-mono font-bold text-slate-700">
                              {log.codigo_empleado}
                            </td>
                            <td className="px-4 py-3 font-bold text-slate-900">{log.nombre_usuario}</td>
                            <td className="px-4 py-3 text-slate-500">{log.cargo}</td>
                            <td className="px-4 py-3 text-slate-700">
                              {log.hora_ingreso
                                ? new Date(log.hora_ingreso).toLocaleString([], {
                                    dateStyle: 'short',
                                    timeStyle: 'short',
                                  })
                                : '-'}
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-blue-700">
                                {log.estacion_ingreso_nombre || 'Fuera de estación'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {log.tiene_foto_ingreso ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPhotoPreview({
                                      url: `/photos/attendance/${log.id}/in`,
                                      workerName: log.nombre_usuario,
                                      type: 'entrada',
                                      date: log.hora_ingreso,
                                      stationName: log.estacion_ingreso_nombre,
                                      referencePhotoUrl: log.foto_ref_bytes
                                        ? `/photos/user/${log.usuario_id}/reference?v=${log.foto_ref_bytes}`
                                        : null,
                                      similarity: log.similitud_facial,
                                    })
                                  }
                                  title="Ver evidencia de entrada"
                                  className="inline-flex border border-slate-300 bg-white p-0.5 transition-colors hover:border-brand-600"
                                >
                                  <AuthImage
                                    path={`/photos/attendance/${log.id}/in`}
                                    alt="Foto Entrada"
                                    className="w-10 h-10 object-cover rounded-md"
                                  />
                                </button>
                              ) : (
                                <span className="text-xs text-slate-400 italic">Sin foto</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {log.hora_salida
                                ? new Date(log.hora_salida).toLocaleString([], {
                                    dateStyle: 'short',
                                    timeStyle: 'short',
                                  })
                                : '—'}
                            </td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-slate-600">
                                {log.estacion_salida_nombre || (log.estado === 'activo' ? 'En turno' : '—')}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {log.tiene_foto_salida ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPhotoPreview({
                                      url: `/photos/attendance/${log.id}/out`,
                                      workerName: log.nombre_usuario,
                                      type: 'salida',
                                      date: log.hora_salida,
                                      stationName: log.estacion_salida_nombre,
                                      referencePhotoUrl: log.foto_ref_bytes
                                        ? `/photos/user/${log.usuario_id}/reference?v=${log.foto_ref_bytes}`
                                        : null,
                                      similarity: log.similitud_facial,
                                    })
                                  }
                                  title="Ver evidencia de salida"
                                  className="inline-flex border border-slate-300 bg-white p-0.5 transition-colors hover:border-brand-600"
                                >
                                  <AuthImage
                                    path={`/photos/attendance/${log.id}/out`}
                                    alt="Foto Salida"
                                    className="w-10 h-10 object-cover rounded-md"
                                  />
                                </button>
                              ) : (
                                <span className="text-xs text-slate-400 italic">
                                  {log.estado === 'activo' ? 'En turno' : 'Sin foto'}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {log.similitud_facial !== null && log.similitud_facial !== undefined ? (
                                <div className="inline-flex flex-col items-center">
                                  <span
                                    className={`px-2 py-0.5 rounded-full text-xs font-bold flex items-center space-x-1 ${
 log.verificacion_facial_exitosa
 ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
 : 'bg-rose-100 text-rose-800 border border-rose-300'
 }`}
                                  >
                                    <ScanFace className="w-3 h-3" />
                                    <span>{Math.round(log.similitud_facial)}%</span>
                                  </span>
                                  <span className="text-xs text-slate-400 mt-0.5">
                                    {log.verificacion_facial_exitosa ? 'Verificado' : 'Alerta'}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-slate-400 italic">No requerida</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">
                              {log.horas_totales !== null ? `${log.horas_totales}h` : 'En curso'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-bold ${
 log.estado === 'activo'
 ? 'bg-emerald-100 text-emerald-800'
 : 'bg-slate-100 text-slate-600'
 }`}
                              >
                                {log.estado === 'activo' ? 'Activo' : 'Completado'}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Paginación */}
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 text-xs text-slate-500">
                  <span>
                    {logsTotal === 0
                      ? 'Sin registros'
                      : `Mostrando ${logsPage * LOGS_PAGE_SIZE + 1}–${Math.min((logsPage + 1) * LOGS_PAGE_SIZE, logsTotal)} de ${logsTotal}`}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={logsPage === 0}
                      onClick={() => setLogsPage((p) => Math.max(0, p - 1))}
                      className="px-3 py-1.5 font-bold bg-white border border-slate-300 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition"
                    >
                      ← Anterior
                    </button>
                    <button
                      type="button"
                      disabled={(logsPage + 1) * LOGS_PAGE_SIZE >= logsTotal}
                      onClick={() => setLogsPage((p) => p + 1)}
                      className="px-3 py-1.5 font-bold bg-white border border-slate-300 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition"
                    >
                      Siguiente →
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Tab: Personal & Biometría */}
            {activeTab === 'workers' && (
              <div className="space-y-4">
                <div className="bg-blue-50/80 border border-blue-200/80 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-bold text-blue-950 flex items-center gap-1.5">
                      <ScanFace className="w-4 h-4 text-blue-600" />
                      Gestión de Personal & Biometría Facial 1:1
                    </h3>
                    <p className="text-xs text-blue-800 mt-0.5">
                      Registra nuevos trabajadores, enrola o resetea su biometría. Los nuevos trabajadores se auto-enrolan en su primera marcación.
                    </p>
                  </div>
                  <div className="flex items-center space-x-2 flex-shrink-0">
                    <div className="flex items-center space-x-1.5 text-xs font-semibold text-blue-900 bg-white px-3 py-1.5 rounded-xl border border-blue-200">
                      <span>Enrolados:</span>
                      <span className="font-bold text-emerald-600">
                        {workersList.filter((w) => w.facial_enrolado).length} / {workersList.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setNewWorkerCode(`EMP-${100 + workersList.length + 1}`);
                        setShowNewWorkerModal(true);
                      }}
                      className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold flex items-center space-x-1.5 transition cursor-pointer shadow-md"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Nuevo Trabajador</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredWorkersList.length === 0 ? (
                    <div className="col-span-full bg-white p-8 rounded-2xl border border-slate-200 text-center text-slate-400 text-xs">
                      No se encontraron trabajadores con el término de búsqueda.
                    </div>
                  ) : (
                    filteredWorkersList.map((worker) => {
                      const isEnrolled = !!worker.facial_enrolado;
                      return (
                        <div
                          key={worker.id}
                          className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col justify-between hover:border-slate-300 transition"
                        >
                          <div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center space-x-3">
                                {worker.foto_ref_bytes ? (
                                  <AuthImage
                                    path={`/photos/user/${worker.id}/reference?v=${worker.foto_ref_bytes}`}
                                    alt={worker.nombre}
                                    className="h-12 w-12 flex-shrink-0 border border-slate-300 object-cover"
                                    fallback={
                                      <div className="grid h-12 w-12 flex-shrink-0 place-items-center border border-slate-300 bg-slate-100 text-sm font-semibold text-slate-600">
                                        {worker.nombre.slice(0, 2).toUpperCase()}
                                      </div>
                                    }
                                  />
                                ) : (
                                  <div className="grid h-12 w-12 flex-shrink-0 place-items-center border border-slate-300 bg-slate-100 text-sm font-semibold text-slate-600">
                                    {worker.nombre.slice(0, 2).toUpperCase()}
                                  </div>
                                )}
                                <div>
                                  <h4 className="font-bold text-xs text-slate-900 leading-tight">{worker.nombre}</h4>
                                  <p className="text-xs text-slate-500">{worker.cargo}</p>
                                  <span className="inline-block mt-0.5 text-xs font-mono font-bold bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded">
                                    {worker.codigo_empleado}
                                  </span>
                                </div>
                              </div>

                              <span
                                className={`px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0 ${
 isEnrolled
 ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
 : 'bg-amber-100 text-amber-800 border border-amber-200'
 }`}
                              >
                                {isEnrolled ? 'Enrolado' : 'Pendiente'}
                              </span>
                            </div>

                            <div className="mt-3 text-xs text-slate-600 bg-slate-50 p-2.5 rounded-xl border border-slate-100 space-y-1">
                              <div className="flex justify-between">
                                <span className="text-slate-400">Rol Sistema:</span>
                                <span className="font-semibold text-slate-700 capitalize">{worker.rol}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">Vector Facial:</span>
                                <span className="font-mono text-slate-700">
                                  {isEnrolled ? '128 dimensiones ' : 'Auto-enrolable en 1er login'}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-1.5">
                            {isEnrolled ? (
                              <button
                                type="button"
                                onClick={() => handleResetFace(worker.id, worker.nombre)}
                                className="text-xs text-rose-600 hover:text-rose-800 font-bold hover:underline cursor-pointer"
                              >
                                Resetear Rostro
                              </button>
                            ) : (
                              <span className="text-xs text-slate-400">Sin biometría</span>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                setSelectedWorkerForEnrol(worker);
                                setShowEnrolModal(true);
                              }}
                              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold flex items-center space-x-1 transition cursor-pointer shadow-sm"
                            >
                              <ScanFace className="w-3.5 h-3.5" />
                              <span>{isEnrolled ? 'Re-enrolar' : 'Enrolar Ahora'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Tab: Alertas de Fraude */}
            {activeTab === 'fraud' && (
              <div className="space-y-4">
                <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-rose-600 text-white flex items-center justify-center flex-shrink-0 shadow">
                      <ShieldAlert className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-rose-950">
                        Auditoría de Intentos de Fraude y Suplantación Biométrica
                      </h3>
                      <p className="text-xs text-rose-700 mt-0.5">
                        Registros en vivo cuando un intento de marcación no supera el umbral de coincidencia facial (&lt; 60%) o falla la prueba de vida (parpadeo EAR).
                      </p>
                    </div>
                  </div>
                  <span className="px-3 py-1 bg-rose-600 text-white font-bold text-xs rounded-xl shadow-sm">
                    {fraudLogs.length} Alerta{fraudLogs.length === 1 ? '' : 's'}
                  </span>
                </div>

                {filteredFraudLogs.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center shadow-sm">
                    <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3">
                      <ShieldCheck className="w-8 h-8" />
                    </div>
                    <h4 className="text-sm font-bold text-slate-800">Cero Intentos de Fraude</h4>
                    <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                      No se han detectado suplantaciones ni desajustes biométricos. Todas las marcaciones han cumplido los criterios de verificación 1:1.
                    </p>
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs text-slate-600">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold text-xs tracking-wider">
                          <tr>
                            <th className="px-4 py-3">Fecha y Hora</th>
                            <th className="px-4 py-3">Trabajador Afectado</th>
                            <th className="px-4 py-3">Tipo de Evento</th>
                            <th className="px-4 py-3 text-center">Similitud Obtenida</th>
                            <th className="px-4 py-3 text-center">Foto del Intento</th>
                            <th className="px-4 py-3">Ubicación GPS</th>
                            <th className="px-4 py-3">Detalle / Notas</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredFraudLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-rose-50/30 transition">
                              <td className="px-4 py-3 font-mono text-slate-700 whitespace-nowrap">
                                {new Date(log.fecha_intento).toLocaleString([], {
                                  dateStyle: 'short',
                                  timeStyle: 'medium',
                                })}
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-bold text-slate-900">{log.nombre_usuario || `Usuario #${log.usuario_id}`}</div>
                                <span className="text-xs font-mono text-slate-500">{log.codigo_empleado}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-300">
                                  {etiquetaEvento(log.tipo_evento)}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className="font-bold text-xs text-rose-600 font-mono">
                                  {log.similitud_obtenida !== null && log.similitud_obtenida !== undefined
                                    ? `${Math.round(log.similitud_obtenida)}%`
                                    : '0%'}
                                </span>
                                <p className="text-xs text-slate-400">Mínimo: 60%</p>
                              </td>
                              <td className="px-4 py-3 text-center">
                                {log.tiene_foto_intento ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setPhotoPreview({
                                        url: `/photos/fraud/${log.id}`,
                                        workerName: log.nombre_usuario,
                                        type: 'entrada',
                                        date: log.fecha_intento,
                                        similarity: log.similitud_obtenida,
                                      })
                                    }
                                    className="inline-flex border border-slate-300 bg-white p-0.5 transition-colors hover:border-brand-600"
                                  >
                                    <AuthImage
                                      path={`/photos/fraud/${log.id}`}
                                      alt="Intento Fraudulento"
                                      className="w-10 h-10 object-cover rounded-md"
                                    />
                                  </button>
                                ) : (
                                  <span className="text-xs text-slate-400 italic">Sin foto</span>
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-600">
                                {log.latitud && log.longitud ? (
                                  <a
                                    href={`https://www.google.com/maps?q=${log.latitud},${log.longitud}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-600 hover:underline flex items-center gap-1"
                                  >
                                    <MapPin className="w-3 h-3" />
                                    <span>
                                      {log.latitud.toFixed(4)}, {log.longitud.toFixed(4)}
                                    </span>
                                  </a>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-600 max-w-xs truncate" title={log.notas || ''}>
                                {log.notas || 'Rostro no coincide con el descriptor enrolado'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Tab 3: Workstations Config */}
            {activeTab === 'stations' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {workstations.map((st) => (
                  <div
                    key={st.id}
                    className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span
                          className="w-3.5 h-3.5 rounded-full inline-block"
                          style={{ backgroundColor: st.color }}
                        />
                        <span className="text-xs font-mono font-bold bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                          {st.codigo}
                        </span>
                      </div>
                      <h4 className="font-bold text-sm text-slate-900">{st.nombre}</h4>
                      <p className="text-xs text-slate-500 mt-1">{st.descripcion || 'Sin descripción'}</p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-600 space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Radio de Geocerca:</span>
                        <span className="font-bold text-blue-600">{st.radio_metros} metros</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Coordenadas:</span>
                        <span className="font-mono text-xs text-slate-700">
                          {st.latitud.toFixed(4)}, {st.longitud.toFixed(4)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Modal: Nueva Estación */}
      {showNewStationModal && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <h3 className="font-bold text-lg text-slate-900 mb-4">Nueva Estación de Trabajo (Geocerca)</h3>
            <form onSubmit={handleCreateStation} className="space-y-3 text-xs">
              {/* Opción Rápida: Pegar Link de Google Maps */}
              <div className="bg-blue-50/80 border border-blue-200/90 p-3 rounded-2xl space-y-2">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-blue-900 text-xs flex items-center">
                    <Link className="w-3.5 h-3.5 mr-1 text-blue-600" />
                    <span>Pegar Link de Google Maps:</span>
                  </label>
                  <span className="text-xs text-blue-600 font-semibold bg-blue-100/70 px-1.5 py-0.5 rounded">
                    Auto-detección
                  </span>
                </div>
                <div className="flex space-x-1.5">
                  <input
                    type="url"
                    value={mapsUrlInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setMapsUrlInput(val);
                      if (val.includes('@') || val.includes('!3d') || val.includes('goo.gl')) {
                        handleExtractFromMapsUrl(val);
                      }
                    }}
                    placeholder="ej. https://maps.app.goo.gl/... o https://google.com/maps/@..."
                    className="flex-1 p-2 text-xs bg-white border border-blue-200 rounded-xl font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => handleExtractFromMapsUrl()}
                    disabled={isParsingUrl}
                    className="btn-primary btn-sm flex-shrink-0"
                  >
                    {isParsingUrl ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <>
                        <MapPin className="w-3.5 h-3.5" />
                        <span>Extraer</span>
                      </>
                    )}
                  </button>
                </div>
                {parseStatus && (
                  <p
                    className={`text-xs font-semibold flex items-center gap-1 ${
 parseStatus.type === 'success' ? 'text-emerald-700' : 'text-rose-600'
 }`}
                  >
                    {parseStatus.type === 'success' ? '' : ''} {parseStatus.message}
                  </p>
                )}
                <p className="text-xs text-slate-500">
                  Copie el enlace desde Google Maps para autocompletar las coordenadas.
                </p>
              </div>

              <div>
                <label className="field-label">Código (ej. EST-05):</label>
                <input
                  type="text"
                  required
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="field"
                />
              </div>

              <div>
                <label className="field-label">Nombre de Estación:</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ej. Patio de Maniobras Norte"
                  className="field"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">Latitud:</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={newLat}
                    onChange={(e) => setNewLat(e.target.value)}
                    className="field font-mono"
                  />
                </div>
                <div>
                  <label className="field-label">Longitud:</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={newLng}
                    onChange={(e) => setNewLng(e.target.value)}
                    className="field font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">Radio (metros):</label>
                  <input
                    type="number"
                    required
                    value={newRadius}
                    onChange={(e) => setNewRadius(e.target.value)}
                    className="field"
                  />
                </div>
                <div>
                  <label className="field-label">Color Identificador:</label>
                  <input
                    type="color"
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                    className="field"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-4">
                <button
                  type="button"
                  onClick={() => setShowNewStationModal(false)}
                  className="btn-secondary"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingStation}
                  className="btn-primary"
                >
                  {isSavingStation ? 'Guardando en BD...' : 'Guardar Estación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Vista Previa de Evidencia Fotográfica y Comparación Biométrica */}
      {/* Ventana: enviar alerta al celular de un trabajador */}
      {alertTarget && (
        <div className="fixed inset-0 bg-slate-950/70 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm text-slate-900">Enviar alerta al celular</h3>
                <p className="text-xs text-slate-500">
                  {alertTarget.nombre_usuario} · {alertTarget.codigo_empleado}
                  {alertTarget.dentro_de_estacion ? '' : ' · Fuera de zona'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAlertTarget(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {ALERT_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setAlertMsg(p)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border text-left transition ${
 alertMsg === p
 ? 'bg-blue-600 text-white border-blue-600'
 : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100'
 }`}
                  >
                    {p}
                  </button>
                ))}
              </div>

              <div>
                <label className="field-label">Mensaje:</label>
                <textarea
                  value={alertMsg}
                  onChange={(e) => setAlertMsg(e.target.value.slice(0, 200))}
                  rows={3}
                  placeholder="Escriba el aviso para el trabajador…"
                  className="field"
                />
                <p className="text-xs text-slate-400 text-right">{alertMsg.length}/200</p>
              </div>

              {alertTarget.push_activo === 0 || alertTarget.push_activo === false ? (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                  Este trabajador todavía no activó las alertas en su celular: solo verá el mensaje si abre la app.
                </p>
              ) : null}

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setAlertTarget(null)}
                  className="btn-secondary"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSendAlert}
                  disabled={alertSending || !alertMsg.trim()}
                  className="btn-primary"
                >
                  {alertSending ? 'Enviando…' : 'Enviar alerta'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {photoPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-slate-300 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {photoPreview.referencePhotoUrl
                    ? 'Comparación biométrica'
                    : `Evidencia de ${photoPreview.type === 'entrada' ? 'entrada' : 'salida'}`}
                </h3>
                <p className="text-sm text-slate-600">{photoPreview.workerName}</p>
              </div>
              <button
                onClick={() => setPhotoPreview(null)}
                aria-label="Cerrar"
                className="p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Comparación lado a lado si existe foto de referencia */}
            {photoPreview.referencePhotoUrl ? (
              <div className="space-y-4 bg-slate-50 p-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <figure className="flex flex-col items-center border border-slate-300 bg-white p-3">
                    <figcaption className="mb-2 text-sm font-medium text-slate-700">Rostro registrado</figcaption>
                    <AuthImage
                      eager
                      path={photoPreview.referencePhotoUrl}
                      alt="Rostro registrado"
                      className="max-h-56 w-auto max-w-full border border-slate-200 object-contain"
                    />
                    <span className="mt-2 text-xs text-slate-500">Patrón biométrico de referencia</span>
                  </figure>

                  <figure className="flex flex-col items-center border border-slate-300 bg-white p-3">
                    <figcaption className="mb-2 text-sm font-medium text-slate-700">Foto de la marcación</figcaption>
                    <AuthImage
                      eager
                      path={photoPreview.url}
                      alt="Foto de la marcación"
                      className="max-h-56 w-auto max-w-full border border-slate-200 object-contain"
                    />
                    <span className="mt-2 text-xs text-slate-500">Captura en vivo con prueba de vida</span>
                  </figure>
                </div>

                {/* Coincidencia biométrica */}
                {photoPreview.similarity !== null && photoPreview.similarity !== undefined && (
                  <div className="flex items-center justify-between border border-slate-300 bg-white px-4 py-3">
                    <span className="text-sm font-medium text-slate-700">Coincidencia biométrica</span>
                    <span
                      className={`tag tabular-nums ${
                        photoPreview.similarity >= 60
                          ? 'border-green-200 bg-green-50 text-green-800'
                          : 'border-red-200 bg-red-50 text-red-800'
                      }`}
                    >
                      {Math.round(photoPreview.similarity)}% · {photoPreview.similarity >= 60 ? 'Verificado' : 'No coincide'}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center bg-slate-50 p-4">
                <AuthImage
                  eager
                  path={photoPreview.url}
                  alt={`Evidencia ${photoPreview.type}`}
                  className="max-h-[60vh] w-auto max-w-full border border-slate-300 object-contain"
                />
              </div>
            )}

            <div className="flex flex-col items-start justify-between gap-3 border-t border-slate-200 px-5 py-4 text-sm sm:flex-row sm:items-center">
              <div className="space-y-0.5 text-slate-700">
                <p>
                  <span className="text-slate-500">Fecha y hora: </span>
                  {photoPreview.date
                    ? new Date(photoPreview.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' })
                    : 'No registrada'}
                </p>
                {photoPreview.stationName && (
                  <p>
                    <span className="text-slate-500">Estación detectada: </span>
                    {photoPreview.stationName}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    // La foto es protegida: se descarga con la sesión y luego se entrega como archivo
                    const blobUrl = await api.fetchPhoto(photoPreview.url);
                    const link = document.createElement('a');
                    link.href = blobUrl;
                    link.download = `evidencia_${photoPreview.workerName}_${photoPreview.type}.jpg`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                  } catch {
                    alert('No se pudo descargar la foto.');
                  }
                }}
                className="btn-primary btn-sm"
              >
                <Download className="h-3.5 w-3.5" />
                Descargar foto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Nuevo Trabajador */}
      {showNewWorkerModal && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                  <UserCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-slate-900">Registrar Nuevo Trabajador</h3>
                  <p className="text-xs text-slate-500">Alta de personal y credenciales de marcación</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNewWorkerModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateWorker} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">Código Empleado:</label>
                  <input
                    type="text"
                    required
                    value={newWorkerCode}
                    onChange={(e) => setNewWorkerCode(e.target.value)}
                    placeholder="ej. EMP-105"
                    className="field font-mono"
                  />
                </div>
                <div>
                  <label className="field-label">PIN de Acceso (opcional):</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4,6}"
                    maxLength={6}
                    value={newWorkerPin}
                    onChange={(e) => setNewWorkerPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="4-6 dígitos (vacío = generar)"
                    className="field font-mono text-center"
                  />
                </div>
              </div>

              <div>
                <label className="field-label">Nombre Completo:</label>
                <input
                  type="text"
                  required
                  value={newWorkerName}
                  onChange={(e) => setNewWorkerName(e.target.value)}
                  placeholder="ej. Juan Carlos Pérez Rojas"
                  className="field"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">Cargo / Puesto:</label>
                  <input
                    type="text"
                    value={newWorkerCargo}
                    onChange={(e) => setNewWorkerCargo(e.target.value)}
                    placeholder="ej. Operador de Campo"
                    className="field"
                  />
                </div>
                <div>
                  <label className="field-label">Teléfono:</label>
                  <input
                    type="tel"
                    value={newWorkerPhone}
                    onChange={(e) => setNewWorkerPhone(e.target.value)}
                    placeholder="ej. 987654321"
                    className="field"
                  />
                </div>
              </div>

              <div className="bg-blue-50/70 border border-blue-200 p-3 rounded-2xl text-xs text-blue-900 space-y-1">
                <p className="font-bold flex items-center gap-1">
                  <span></span> Enrolamiento Biométrico Facial:
                </p>
                <p className="text-blue-700">
                  El trabajador podrá <strong>auto-enrolar su rostro en su primera marcación</strong> desde el celular o puedes enrolarlo inmediatamente después de crearlo con el botón "Enrolar Ahora".
                </p>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewWorkerModal(false)}
                  className="btn-secondary"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingWorker}
                  className="btn-primary"
                >
                  {isSavingWorker ? 'Guardando en BD...' : 'Crear Trabajador'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Enrolamiento Facial Maestro */}
      {showEnrolModal && selectedWorkerForEnrol && (
        <EnrolFaceModal
          isOpen={showEnrolModal}
          worker={selectedWorkerForEnrol}
          onClose={() => {
            setShowEnrolModal(false);
            setSelectedWorkerForEnrol(null);
          }}
          onEnrolSuccess={() => {
            setShowEnrolModal(false);
            setSelectedWorkerForEnrol(null);
            loadData();
          }}
        />
      )}

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-3 text-center text-xs text-slate-400 font-medium">
        © {new Date().getFullYear()} SMI · Panel de control de asistencia
      </footer>
    </div>
  );
};
