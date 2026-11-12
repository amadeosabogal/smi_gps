import React, { useState, useEffect, useCallback } from 'react';
import { api, auth } from '../services/api';
import { socket, connectSocket, disconnectSocket } from '../services/socket';
import { LiveMap } from '../components/LiveMap';
import { GoogleLiveMap } from '../components/GoogleLiveMap';
import { EnrolFaceModal } from '../components/EnrolFaceModal';
import type {
  EstacionTrabajo,
  ResumenDashboard,
  DatosTrabajadorEnVivo,
  RegistroAsistencia,
  Usuario,
  AuditoriaFraudeFacial,
} from '../types';
import {
  Users,
  MapPin,
  ShieldCheck,
  AlertTriangle,
  Clock,
  Download,
  Search,
  Plus,
  Layers,
  FileSpreadsheet,
  Lock,
  LogOut,
  Shield,
  Camera,
  X,
  Link,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';

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
    <span className="font-mono font-extrabold text-sm text-blue-700 tabular-nums">
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

  // Load data from backend
  const loadData = useCallback(async () => {
    try {
      const [stationsData, logsData, liveData, usersData, fraudData] = await Promise.all([
        api.getWorkstations(),
        api.getAttendanceLogs(),
        api.getLiveDashboard(),
        api.getUsers(),
        api.getFraudLogs(),
      ]);

      setWorkstations(stationsData);
      setAttendanceLogs(logsData);
      setLiveWorkers(liveData.trabajadores);
      if (liveData.ahora) setClockOffsetMs(new Date(liveData.ahora).getTime() - Date.now());
      setSummary(liveData.resumen);
      setWorkersList(usersData);
      setFraudLogs(fraudData);
    } catch (err) {
      console.error('Error cargando datos del panel admin:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdminAuthenticated) return;

    // Asegurar que el socket esté conectado (usa el token de la sesión)
    connectSocket();

    loadData();

    // Sincronización continua de respaldo cada 3 segundos
    const syncInterval = setInterval(() => {
      loadData();
    }, 3000);

    const onConnect = () => {
      console.log('⚡ Socket conectado al panel admin');
      setIsSocketConnected(true);
    };
    const onDisconnect = () => {
      console.warn('❌ Socket desconectado del panel admin');
      setIsSocketConnected(false);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Evento de Telemetría GPS en tiempo real
    socket.on('location_ping', (data: any) => {
      console.log('📡 Telemetría recibida en vivo:', data);
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
      console.log('🔔 Evento de asistencia recibido en socket:', eventData);
      loadData();

      const ahora = new Date().toLocaleTimeString();
      if (eventData?.tipo === 'CHECK_IN') {
        setRecentNotification({
          texto: `🟢 Entrada registrada en tiempo real (${ahora})`,
          fecha: ahora,
        });
      } else if (eventData?.tipo === 'CHECK_OUT') {
        setRecentNotification({
          texto: `🔴 Salida registrada. GPS detenido (${ahora})`,
          fecha: ahora,
        });
      }
    });

    // Evento de Alerta de Fraude Facial
    socket.on('fraud_alert', (fraudEvent: any) => {
      console.warn('🚨 Alerta de fraude facial recibida:', fraudEvent);
      loadData();
      const ahora = new Date().toLocaleTimeString();
      setRecentNotification({
        texto: `🚨 ALERTA: Intento de suplantación facial detectado (${
          fraudEvent?.similitudObtenida ? Math.round(fraudEvent.similitudObtenida) + '%' : 'No coincide'
        }) a las ${ahora}`,
        fecha: ahora,
      });
    });

    // Evento de Enrolamiento Facial
    socket.on('user_face_enrolled', (data: any) => {
      console.log('👤 Rostro enrolado en tiempo real:', data);
      loadData();
    });

    socket.on('workstations_updated', (newStation: EstacionTrabajo) => {
      setWorkstations((prev) => [...prev, newStation]);
    });

    return () => {
      clearInterval(syncInterval);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('location_ping');
      socket.off('attendance_event');
      socket.off('fraud_alert');
      socket.off('user_face_enrolled');
      socket.off('workstations_updated');
    };
  }, [isAdminAuthenticated, loadData]);

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

  const filteredLogs = attendanceLogs.filter(
    (log) =>
      (log.nombre_usuario || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (log.codigo_empleado || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

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

  // Export CSV
  const handleExportCSV = () => {
    if (attendanceLogs.length === 0) {
      alert('No hay registros para exportar');
      return;
    }

    const headers = [
      'ID',
      'Código Empleado',
      'Trabajador',
      'Cargo',
      'Hora Ingreso',
      'Estación Ingreso',
      'Hora Salida',
      'Estación Salida',
      'Horas Totales',
      'Similitud Facial',
      'Biometría Exitosa',
      'Método Validación',
      'Estado',
    ];

    const rows = attendanceLogs.map((log) => [
      log.id,
      log.codigo_empleado || '',
      `"${log.nombre_usuario || ''}"`,
      `"${log.cargo || ''}"`,
      log.hora_ingreso ? new Date(log.hora_ingreso).toLocaleString() : '',
      `"${log.estacion_ingreso_nombre || 'Fuera de estación'}"`,
      log.hora_salida ? new Date(log.hora_salida).toLocaleString() : 'En curso',
      `"${log.estacion_salida_nombre || ''}"`,
      log.horas_totales || '',
      log.similitud_facial !== null && log.similitud_facial !== undefined ? `${Math.round(log.similitud_facial)}%` : '',
      log.verificacion_facial_exitosa ? 'SI' : 'NO',
      log.metodo_validacion || 'facial_biometrico',
      log.estado,
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `SMI_Reporte_Asistencia_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

  // Admin Login Screen
  if (!isAdminAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col justify-center items-center px-4 py-8 font-sans">
        <div className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl border border-slate-200">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-slate-900 flex items-center justify-center shadow-lg shadow-slate-900/30 mb-3 text-blue-500">
              <Shield className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-extrabold text-slate-900">Consola Administrativa</h2>
            <p className="text-xs text-slate-500 mt-0.5">Acceso Exclusivo de Supervisión SMI</p>
          </div>

          <form onSubmit={handleAdminLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                Código de Usuario:
              </label>
              <input
                type="text"
                value={adminCode}
                onChange={(e) => setAdminCode(e.target.value)}
                placeholder="ej. ADM-001"
                autoComplete="username"
                className="w-full bg-slate-50 border border-slate-300 text-slate-900 text-sm font-bold rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                Clave de Seguridad:
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => setAdminPin(e.target.value)}
                  placeholder="Introduce tu clave..."
                  autoComplete="current-password"
                  className="w-full bg-slate-50 border border-slate-300 text-slate-900 text-sm font-bold rounded-xl px-4 py-2.5 pl-10 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            <button
              type="submit"
              disabled={adminLoginLoading || !adminCode.trim() || !adminPin}
              className="w-full py-3 disabled:opacity-60 bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-sm rounded-xl shadow-lg transition transform active:scale-95 cursor-pointer"
            >
              {adminLoginLoading ? 'Verificando...' : 'Iniciar Sesión en Panel'}
            </button>
          </form>
        </div>

        <p className="text-[11px] text-slate-500 text-center mt-6">
          SMI GPS Asistencia & Geocercas • Servidor SQL Server [GPS_SMI]
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans">
      {/* Dedicated Admin Header */}
      <header className="bg-slate-900 border-b border-slate-800 text-white sticky top-0 z-50 shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <MapPin className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold text-xl tracking-tight text-white">SMI</span>
                <span className="text-xs bg-blue-500/20 text-blue-300 font-semibold px-2 py-0.5 rounded-full border border-blue-500/30">
                  Panel Administrativo
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium">Monitoreo & Geocercas en Tiempo Real</p>
            </div>
          </div>

          <div className="flex items-center space-x-3 text-xs">
            {/* Live socket pill */}
            <div className="flex items-center space-x-2 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700">
              <span
                className={`w-2 h-2 rounded-full ${
                  isSocketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span className="text-slate-300 font-medium">
                {isSocketConnected ? 'En Vivo' : 'Desconectado'}
              </span>
            </div>

            {/* Logout button */}
            <button
              onClick={handleAdminLogout}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Cerrar Sesión</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Admin View */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full">
        {loading ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-3">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Conectando con base de datos SQL Server...
            </p>
          </div>
        ) : (
          <>
            {/* Notificación Instantánea de Telemetría o Asistencia */}
            {recentNotification && (
              <div className="mb-4 p-3.5 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center justify-between text-xs font-bold shadow-lg shadow-blue-500/20 border border-blue-400/30">
                <div className="flex items-center space-x-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-300 animate-ping"></span>
                  <span>{recentNotification.texto}</span>
                </div>
                <button
                  onClick={() => setRecentNotification(null)}
                  className="text-white/80 hover:text-white text-xs underline font-normal cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            )}

            {/* Metric Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Personal</p>
                  <h3 className="text-2xl font-black text-slate-800 mt-1">{summary.totalTrabajadores}</h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <Users className="w-6 h-6" />
                </div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">En Turno Activo</p>
                  <h3 className="text-2xl font-black text-slate-800 mt-1">{summary.activosConteo}</h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                  <Clock className="w-6 h-6" />
                </div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wider">En Estación Asignada</p>
                  <h3 className="text-2xl font-black text-emerald-600 mt-1">{summary.dentroEstacionConteo}</h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <ShieldCheck className="w-6 h-6" />
                </div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-amber-600 uppercase tracking-wider">Fuera de Zona / Tránsito</p>
                  <h3 className="text-2xl font-black text-amber-600 mt-1">{summary.fueraEstacionConteo}</h3>
                </div>
                <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6" />
                </div>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-4 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm mb-6">
              <div className="flex flex-wrap items-center gap-1">
                <button
                  onClick={() => setActiveTab('map')}
                  className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeTab === 'map' ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <MapPin className="w-4 h-4" />
                  <span>Mapa en Tiempo Real</span>
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeTab === 'logs' ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  <span>Historial Asistencia ({attendanceLogs.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('workers')}
                  className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeTab === 'workers' ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <UserCheck className="w-4 h-4" />
                  <span>Personal & Biometría ({workersList.length})</span>
                </button>
                <button
                  onClick={() => setActiveTab('fraud')}
                  className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeTab === 'fraud'
                      ? 'bg-rose-600 text-white shadow'
                      : fraudLogs.length > 0
                      ? 'text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <ShieldAlert className="w-4 h-4" />
                  <span>Alertas de Fraude</span>
                  {fraudLogs.length > 0 && (
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-black ${
                        activeTab === 'fraud' ? 'bg-white text-rose-600' : 'bg-rose-600 text-white animate-pulse'
                      }`}
                    >
                      {fraudLogs.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('stations')}
                  className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeTab === 'stations' ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Layers className="w-4 h-4" />
                  <span>Estaciones ({workstations.length})</span>
                </button>
              </div>

              <div className="flex items-center space-x-2">
                <div className="relative flex-1 sm:w-64">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Buscar trabajador o código..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                </div>

                {activeTab === 'logs' && (
                  <button
                    onClick={handleExportCSV}
                    className="flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-sm transition"
                  >
                    <Download className="w-4 h-4" />
                    <span>Exportar CSV</span>
                  </button>
                )}

                {activeTab === 'stations' && (
                  <button
                    onClick={() => setShowNewStationModal(true)}
                    className="flex items-center space-x-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl shadow-sm transition"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Nueva Estación</span>
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
                        className={`px-3 py-1 rounded-md font-extrabold text-[11px] transition cursor-pointer ${
                          mapProvider === 'google'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Google Maps Oficial
                      </button>
                      <button
                        onClick={() => setMapProvider('leaflet')}
                        className={`px-3 py-1 rounded-md font-semibold text-[11px] transition cursor-pointer ${
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
                    <span className="text-[10px] text-slate-400 font-semibold uppercase">SQL Server [GPS_SMI]</span>
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
                                  <span className="text-[10px] font-mono font-bold bg-slate-100 px-1.5 py-0.2 rounded text-slate-600">
                                    {worker.codigo_empleado}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500">{worker.cargo}</p>
                              </div>

                              {isActive ? (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                    isInside
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {isInside ? 'En Estación' : 'Fuera de Zona'}
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-400">
                                  Inactivo
                                </span>
                              )}
                            </div>

                            {isActive && worker.hora_ingreso && (
                              <div className="mt-2 flex items-center justify-between bg-blue-50 border border-blue-100 rounded-lg px-2.5 py-1.5">
                                <div className="flex flex-col leading-tight">
                                  <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wide">
                                    ⏱ Tiempo en turno
                                  </span>
                                  <span className="text-[10px] text-slate-500">
                                    Ingresó a las{' '}
                                    {new Date(worker.hora_ingreso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                                <ElapsedTimer since={worker.hora_ingreso} offsetMs={clockOffsetMs} />
                              </div>
                            )}

                            {isActive && (
                              <div className="mt-2 text-[11px] text-slate-500 bg-white p-2 rounded-lg border border-slate-100 flex items-center justify-between">
                                <span className="font-medium text-slate-700">
                                  {worker.estacion_nombre ? `📍 ${worker.estacion_nombre}` : '📍 Sin estación fija'}
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
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-600">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold text-[10px] tracking-wider">
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
                            No hay registros de asistencia aún.
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
                              {log.foto_ingreso_url ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPhotoPreview({
                                      url: log.foto_ingreso_url!,
                                      workerName: log.nombre_usuario,
                                      type: 'entrada',
                                      date: log.hora_ingreso,
                                      stationName: log.estacion_ingreso_nombre,
                                      referencePhotoUrl: log.foto_referencia_url,
                                      similarity: log.similitud_facial,
                                    })
                                  }
                                  title="Ver evidencia de entrada"
                                  className="group relative inline-flex items-center justify-center p-0.5 rounded-lg border-2 border-emerald-500 hover:border-emerald-600 bg-emerald-50 transition transform hover:scale-105 cursor-pointer shadow-sm"
                                >
                                  <img
                                    src={log.foto_ingreso_url}
                                    alt="Foto Entrada"
                                    className="w-10 h-10 object-cover rounded-md"
                                  />
                                  <div className="absolute inset-0 bg-slate-900/30 group-hover:bg-slate-900/10 rounded-md flex items-center justify-center transition">
                                    <Camera className="w-3.5 h-3.5 text-white drop-shadow" />
                                  </div>
                                </button>
                              ) : (
                                <span className="text-[10px] text-slate-400 italic">Sin foto</span>
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
                              {log.foto_salida_url ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPhotoPreview({
                                      url: log.foto_salida_url!,
                                      workerName: log.nombre_usuario,
                                      type: 'salida',
                                      date: log.hora_salida,
                                      stationName: log.estacion_salida_nombre,
                                      referencePhotoUrl: log.foto_referencia_url,
                                      similarity: log.similitud_facial,
                                    })
                                  }
                                  title="Ver evidencia de salida"
                                  className="group relative inline-flex items-center justify-center p-0.5 rounded-lg border-2 border-rose-500 hover:border-rose-600 bg-rose-50 transition transform hover:scale-105 cursor-pointer shadow-sm"
                                >
                                  <img
                                    src={log.foto_salida_url}
                                    alt="Foto Salida"
                                    className="w-10 h-10 object-cover rounded-md"
                                  />
                                  <div className="absolute inset-0 bg-slate-900/30 group-hover:bg-slate-900/10 rounded-md flex items-center justify-center transition">
                                    <Camera className="w-3.5 h-3.5 text-white drop-shadow" />
                                  </div>
                                </button>
                              ) : (
                                <span className="text-[10px] text-slate-400 italic">
                                  {log.estado === 'activo' ? 'En turno' : 'Sin foto'}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {log.similitud_facial !== null && log.similitud_facial !== undefined ? (
                                <div className="inline-flex flex-col items-center">
                                  <span
                                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center space-x-1 ${
                                      log.verificacion_facial_exitosa
                                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                        : 'bg-rose-100 text-rose-800 border border-rose-300'
                                    }`}
                                  >
                                    <ScanFace className="w-3 h-3" />
                                    <span>{Math.round(log.similitud_facial)}%</span>
                                  </span>
                                  <span className="text-[9px] text-slate-400 mt-0.5">
                                    {log.verificacion_facial_exitosa ? 'Verificado' : 'Alerta'}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-400 italic">No requerida</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-mono font-bold text-slate-900">
                              {log.horas_totales !== null ? `${log.horas_totales}h` : 'En curso'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
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
                    <p className="text-[11px] text-blue-800 mt-0.5">
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
                                {worker.foto_referencia_url ? (
                                  <img
                                    src={worker.foto_referencia_url}
                                    alt={worker.nombre}
                                    className="w-12 h-12 rounded-xl object-cover border-2 border-emerald-500 shadow-sm flex-shrink-0"
                                  />
                                ) : (
                                  <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 font-bold text-sm flex-shrink-0">
                                    {worker.nombre.slice(0, 2).toUpperCase()}
                                  </div>
                                )}
                                <div>
                                  <h4 className="font-bold text-xs text-slate-900 leading-tight">{worker.nombre}</h4>
                                  <p className="text-[11px] text-slate-500">{worker.cargo}</p>
                                  <span className="inline-block mt-0.5 text-[10px] font-mono font-bold bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded">
                                    {worker.codigo_empleado}
                                  </span>
                                </div>
                              </div>

                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0 ${
                                  isEnrolled
                                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                    : 'bg-amber-100 text-amber-800 border border-amber-200'
                                }`}
                              >
                                {isEnrolled ? '✓ Enrolado' : 'Pendiente'}
                              </span>
                            </div>

                            <div className="mt-3 text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded-xl border border-slate-100 space-y-1">
                              <div className="flex justify-between">
                                <span className="text-slate-400">Rol Sistema:</span>
                                <span className="font-semibold text-slate-700 capitalize">{worker.rol}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">Vector Facial:</span>
                                <span className="font-mono text-slate-700">
                                  {isEnrolled ? '128 dimensiones ✓' : 'Auto-enrolable en 1er login'}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-1.5">
                            {isEnrolled ? (
                              <button
                                type="button"
                                onClick={() => handleResetFace(worker.id, worker.nombre)}
                                className="text-[11px] text-rose-600 hover:text-rose-800 font-bold hover:underline cursor-pointer"
                              >
                                Resetear Rostro
                              </button>
                            ) : (
                              <span className="text-[10px] text-slate-400">Sin biometría</span>
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
                      <p className="text-[11px] text-rose-700 mt-0.5">
                        Registros en vivo cuando un intento de marcación no supera el umbral de coincidencia facial (&lt; 60%) o falla la prueba de vida (parpadeo EAR).
                      </p>
                    </div>
                  </div>
                  <span className="px-3 py-1 bg-rose-600 text-white font-black text-xs rounded-xl shadow-sm">
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
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold text-[10px] tracking-wider">
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
                                <span className="text-[10px] font-mono text-slate-500">{log.codigo_empleado}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300">
                                  {log.tipo_evento}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className="font-extrabold text-xs text-rose-600 font-mono">
                                  {log.similitud_obtenida !== null && log.similitud_obtenida !== undefined
                                    ? `${Math.round(log.similitud_obtenida)}%`
                                    : '0%'}
                                </span>
                                <p className="text-[9px] text-slate-400">Mínimo: 60%</p>
                              </td>
                              <td className="px-4 py-3 text-center">
                                {log.foto_intento_url ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setPhotoPreview({
                                        url: log.foto_intento_url!,
                                        workerName: log.nombre_usuario,
                                        type: 'entrada',
                                        date: log.fecha_intento,
                                        similarity: log.similitud_obtenida,
                                      })
                                    }
                                    className="group relative inline-flex items-center justify-center p-0.5 rounded-lg border-2 border-rose-500 hover:border-rose-600 bg-rose-50 transition transform hover:scale-105 cursor-pointer shadow-sm"
                                  >
                                    <img
                                      src={log.foto_intento_url}
                                      alt="Intento Fraudulento"
                                      className="w-10 h-10 object-cover rounded-md"
                                    />
                                    <div className="absolute inset-0 bg-slate-900/30 group-hover:bg-slate-900/10 rounded-md flex items-center justify-center transition">
                                      <Camera className="w-3.5 h-3.5 text-white drop-shadow" />
                                    </div>
                                  </button>
                                ) : (
                                  <span className="text-[10px] text-slate-400 italic">Sin foto</span>
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-[11px] text-slate-600">
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
                        <span className="font-mono text-[11px] text-slate-700">
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
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
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
                  <span className="text-[10px] text-blue-600 font-semibold bg-blue-100/70 px-1.5 py-0.5 rounded">
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
                    className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs flex items-center space-x-1 transition disabled:opacity-60 cursor-pointer shadow-sm flex-shrink-0"
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
                    className={`text-[11px] font-semibold flex items-center gap-1 ${
                      parseStatus.type === 'success' ? 'text-emerald-700' : 'text-rose-600'
                    }`}
                  >
                    {parseStatus.type === 'success' ? '✓' : '⚠️'} {parseStatus.message}
                  </p>
                )}
                <p className="text-[10px] text-slate-500">
                  💡 Copia el enlace desde Google Maps en tu móvil o PC para autocompletar las coordenadas.
                </p>
              </div>

              <div>
                <label className="block font-bold text-slate-600 mb-1">Código (ej. EST-05):</label>
                <input
                  type="text"
                  required
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-600 mb-1">Nombre de Estación:</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ej. Patio de Maniobras Norte"
                  className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-600 mb-1">Latitud:</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={newLat}
                    onChange={(e) => setNewLat(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-600 mb-1">Longitud:</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={newLng}
                    onChange={(e) => setNewLng(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-600 mb-1">Radio (metros):</label>
                  <input
                    type="number"
                    required
                    value={newRadius}
                    onChange={(e) => setNewRadius(e.target.value)}
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-600 mb-1">Color Identificador:</label>
                  <input
                    type="color"
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                    className="w-full h-10 p-1 bg-slate-50 border border-slate-300 rounded-xl cursor-pointer"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-4">
                <button
                  type="button"
                  onClick={() => setShowNewStationModal(false)}
                  className="px-4 py-2 font-bold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingStation}
                  className="px-5 py-2 font-bold bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-md transition disabled:opacity-60 cursor-pointer"
                >
                  {isSavingStation ? 'Guardando en BD...' : 'Guardar Estación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Vista Previa de Evidencia Fotográfica y Comparación Biométrica */}
      {photoPreview && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-2xl w-full overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center space-x-2.5">
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    photoPreview.type === 'entrada'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-rose-500/20 text-rose-400'
                  }`}
                >
                  <Camera className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-white">
                    {photoPreview.referencePhotoUrl
                      ? 'Comparación Biométrica 1:1'
                      : `Evidencia de ${photoPreview.type === 'entrada' ? 'Entrada (Check-In)' : 'Salida (Check-Out)'}`}
                  </h3>
                  <p className="text-[11px] text-slate-400">{photoPreview.workerName}</p>
                </div>
              </div>
              <button
                onClick={() => setPhotoPreview(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Comparación lado a lado si existe foto de referencia */}
            {photoPreview.referencePhotoUrl ? (
              <div className="p-5 bg-black/40 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Foto Oficial Enrolada */}
                  <div className="bg-slate-800/60 border border-slate-700 rounded-2xl p-3 flex flex-col items-center">
                    <div className="flex items-center space-x-1.5 mb-2 text-blue-400 text-xs font-bold">
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>Rostro Oficial Enrolado</span>
                    </div>
                    <img
                      src={photoPreview.referencePhotoUrl}
                      alt="Rostro Enrolado"
                      className="max-h-56 w-auto max-w-full rounded-xl border border-slate-600 object-contain shadow-md"
                    />
                    <span className="text-[10px] text-slate-400 mt-2 font-mono">Patrón Biométrico Maestro</span>
                  </div>

                  {/* Foto Capturada en Marcación */}
                  <div className="bg-slate-800/60 border border-slate-700 rounded-2xl p-3 flex flex-col items-center">
                    <div className="flex items-center space-x-1.5 mb-2 text-emerald-400 text-xs font-bold">
                      <ScanFace className="w-3.5 h-3.5" />
                      <span>Foto en Marcación</span>
                    </div>
                    <img
                      src={photoPreview.url}
                      alt="Foto en Marcación"
                      className="max-h-56 w-auto max-w-full rounded-xl border border-slate-600 object-contain shadow-md"
                    />
                    <span className="text-[10px] text-slate-400 mt-2 font-mono">Captura en Vivo + Liveness</span>
                  </div>
                </div>

                {/* Barra de Similitud Biométrica */}
                {photoPreview.similarity !== null && photoPreview.similarity !== undefined && (
                  <div className="bg-slate-800 p-3 rounded-2xl border border-slate-700 flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div
                        className={`w-3 h-3 rounded-full ${
                          photoPreview.similarity >= 60 ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                        }`}
                      />
                      <span className="text-xs font-bold text-white">Coincidencia Biométrica:</span>
                    </div>
                    <span
                      className={`text-xs font-black font-mono px-3 py-1 rounded-xl ${
                        photoPreview.similarity >= 60
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      }`}
                    >
                      {Math.round(photoPreview.similarity)}% {photoPreview.similarity >= 60 ? '✓ Verificado' : '⚠️ No Coincide'}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-4 flex flex-col items-center justify-center bg-black/50">
                <img
                  src={photoPreview.url}
                  alt={`Evidencia ${photoPreview.type}`}
                  className="max-h-[60vh] w-auto max-w-full rounded-2xl border border-slate-700 shadow-xl object-contain"
                />
              </div>
            )}

            <div className="p-4 bg-slate-950/80 border-t border-slate-800 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="space-y-0.5 text-slate-300">
                <p>
                  <span className="text-slate-500 font-semibold">Fecha y Hora: </span>
                  {photoPreview.date
                    ? new Date(photoPreview.date).toLocaleString([], {
                        dateStyle: 'full',
                        timeStyle: 'medium',
                      })
                    : 'No registrada'}
                </p>
                {photoPreview.stationName && (
                  <p>
                    <span className="text-slate-500 font-semibold">Estación Detectada: </span>
                    <span className="text-blue-400 font-medium">📍 {photoPreview.stationName}</span>
                  </p>
                )}
              </div>
              <a
                href={photoPreview.url}
                download={`evidencia_${photoPreview.workerName}_${photoPreview.type}.jpg`}
                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold flex items-center space-x-1.5 transition text-[11px] self-end sm:self-auto cursor-pointer shadow-md"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Descargar Foto</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Nuevo Trabajador */}
      {showNewWorkerModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                  <UserCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base text-slate-900">Registrar Nuevo Trabajador</h3>
                  <p className="text-[11px] text-slate-500">Alta de personal y credenciales de marcación</p>
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
                  <label className="block font-bold text-slate-600 mb-1">Código Empleado:</label>
                  <input
                    type="text"
                    required
                    value={newWorkerCode}
                    onChange={(e) => setNewWorkerCode(e.target.value)}
                    placeholder="ej. EMP-105"
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-mono font-bold text-slate-800 focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-600 mb-1">PIN de Acceso (opcional):</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4,6}"
                    maxLength={6}
                    value={newWorkerPin}
                    onChange={(e) => setNewWorkerPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="4-6 dígitos (vacío = generar)"
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-mono text-center font-bold text-slate-800 focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-600 mb-1">Nombre Completo:</label>
                <input
                  type="text"
                  required
                  value={newWorkerName}
                  onChange={(e) => setNewWorkerName(e.target.value)}
                  placeholder="ej. Juan Carlos Pérez Rojas"
                  className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium text-slate-800 focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-600 mb-1">Cargo / Puesto:</label>
                  <input
                    type="text"
                    value={newWorkerCargo}
                    onChange={(e) => setNewWorkerCargo(e.target.value)}
                    placeholder="ej. Operador de Campo"
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-slate-800 focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-600 mb-1">Teléfono:</label>
                  <input
                    type="tel"
                    value={newWorkerPhone}
                    onChange={(e) => setNewWorkerPhone(e.target.value)}
                    placeholder="ej. 987654321"
                    className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-slate-800 focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="bg-blue-50/70 border border-blue-200 p-3 rounded-2xl text-[11px] text-blue-900 space-y-1">
                <p className="font-bold flex items-center gap-1">
                  <span>📸</span> Enrolamiento Biométrico Facial:
                </p>
                <p className="text-blue-700">
                  El trabajador podrá <strong>auto-enrolar su rostro en su primera marcación</strong> desde el celular o puedes enrolarlo inmediatamente después de crearlo con el botón "Enrolar Ahora".
                </p>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewWorkerModal(false)}
                  className="px-4 py-2 font-bold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingWorker}
                  className="px-5 py-2 font-bold bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-md transition disabled:opacity-60 cursor-pointer"
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
      <footer className="bg-white border-t border-slate-200 py-3 text-center text-[11px] text-slate-400 font-medium">
        SMI Geocercas & Asistencia • Consola Administrativa • SQL Server [GPS_SMI]
      </footer>
    </div>
  );
};
