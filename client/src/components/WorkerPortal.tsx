import React, { useState, useEffect } from 'react';
import type { Usuario, EstacionTrabajo } from '../types';
import { api } from '../services/api';
import { geolocationService, type CoordsData } from '../services/geolocation';
import { 
  LogOut, 
  LogIn, 
  ShieldCheck, 
  AlertTriangle, 
  Navigation, 
  Compass, 
  RefreshCw,
  Smartphone,
  Info
} from 'lucide-react';

interface WorkerPortalProps {
  users: Usuario[];
  workstations: EstacionTrabajo[];
  onAttendanceChanged: () => void;
}

export const WorkerPortal: React.FC<WorkerPortalProps> = ({
  users,
  workstations,
  onAttendanceChanged,
}) => {
  // Trabajadores disponibles
  const workers = users.filter((u) => u.rol === 'trabajador');
  const [selectedUser, setSelectedUser] = useState<Usuario | null>(null);

  // Estado del turno y tracking
  const [isActiveShift, setIsActiveShift] = useState<boolean>(false);
  const [shiftSeconds, setShiftSeconds] = useState<number>(0);
  
  // Estado de geolocalización y geocercas
  const [currentCoords, setCurrentCoords] = useState<CoordsData | null>(null);
  const [detectedStation, setDetectedStation] = useState<EstacionTrabajo | null>(null);
  const [isInsideStation, setIsInsideStation] = useState<boolean>(false);
  const [distanceToNearest, setDistanceToNearest] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Seleccionar primer trabajador por defecto
  useEffect(() => {
    if (workers.length > 0 && !selectedUser) {
      setSelectedUser(workers[0]);
    }
  }, [workers, selectedUser]);

  // Verificar estado del trabajador seleccionado
  useEffect(() => {
    if (!selectedUser) return;

    const checkStatus = async () => {
      try {
        const liveData = await api.getLiveDashboard();
        const workerInfo = liveData.trabajadores.find((w) => w.usuario_id === selectedUser.id);
        
        if (workerInfo && workerInfo.estado_asistencia === 'activo') {
          setIsActiveShift(true);

          if (workerInfo.hora_ingreso) {
            const checkInDate = new Date(workerInfo.hora_ingreso).getTime();
            const now = Date.now();
            setShiftSeconds(Math.max(0, Math.floor((now - checkInDate) / 1000)));
          }

          if (!geolocationService.getTrackingStatus()) {
            startTrackingWorker(selectedUser.id);
          }
        } else {
          setIsActiveShift(false);
          setShiftSeconds(0);
          geolocationService.stopTracking();
        }
      } catch (err) {
        console.error('Error verificando estado del trabajador:', err);
      }
    };

    checkStatus();
  }, [selectedUser]);

  // Cronómetro del turno activo
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

  // Helper para iniciar rastreo continuo
  const startTrackingWorker = (usuarioId: number) => {
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
          console.error('Error enviando ping GPS:', err);
        }
      },
      () => {
        console.warn('No se pudo acceder a la ubicación. Verifica los permisos GPS.');
      }
    );
  };

  // Manejar Registro de Entrada (Check-In)
  const handleCheckIn = async () => {
    if (!selectedUser) return;
    setLoading(true);

    try {
      let lat = -12.046374;
      let lng = -77.042793;
      let acc = 10;

      try {
        const pos = await geolocationService.getCurrentPosition();
        lat = pos.latitude;
        lng = pos.longitude;
        acc = pos.accuracy;
        setCurrentCoords(pos);
      } catch (e) {
        console.warn('GPS no disponible en navegador, usando coordenadas de planta:', e);
      }

      const res = await api.checkIn(selectedUser.id, lat, lng, acc);
      setIsActiveShift(true);
      setShiftSeconds(0);

      if (res.geocerca) {
        setIsInsideStation(res.geocerca.dentroDeEstacion);
        setDetectedStation(res.geocerca.estacion);
        setDistanceToNearest(res.geocerca.distanciaMetros);
      }

      startTrackingWorker(selectedUser.id);
      onAttendanceChanged();
    } catch (err: any) {
      alert(err.message || 'Error al registrar entrada');
    } finally {
      setLoading(false);
    }
  };

  // Manejar Registro de Salida (Check-Out)
  const handleCheckOut = async () => {
    if (!selectedUser) return;
    setLoading(true);

    try {
      let lat: number | undefined;
      let lng: number | undefined;
      let acc: number | undefined;

      try {
        const pos = await geolocationService.getCurrentPosition();
        lat = pos.latitude;
        lng = pos.longitude;
        acc = pos.accuracy;
      } catch (e) {
        console.warn('No se obtuvo GPS para salida');
      }

      await api.checkOut(selectedUser.id, lat, lng, acc);
      await geolocationService.stopTracking();

      setIsActiveShift(false);
      setShiftSeconds(0);
      setCurrentCoords(null);
      setDetectedStation(null);

      onAttendanceChanged();
    } catch (err: any) {
      alert(err.message || 'Error al registrar salida');
    } finally {
      setLoading(false);
    }
  };

  // Simular movimiento a una estación
  const handleSimulateMove = async (stationId: number) => {
    if (!selectedUser || !isActiveShift) return;
    const station = workstations.find((w) => w.id === stationId);
    if (!station) return;

    const simulatedCoords: CoordsData = {
      latitude: station.latitud,
      longitude: station.longitud,
      accuracy: 6,
      timestamp: Date.now(),
    };

    setCurrentCoords(simulatedCoords);
    const res = await api.sendLocationPing(
      selectedUser.id,
      station.latitud,
      station.longitud,
      6
    );

    if (res.geocerca) {
      setIsInsideStation(res.geocerca.dentroDeEstacion);
      setDetectedStation(res.geocerca.estacion);
      setDistanceToNearest(res.geocerca.distanciaMetros);
    }
    onAttendanceChanged();
  };

  return (
    <div className="max-w-xl mx-auto px-4 py-6 font-sans">
      {/* Selector de Trabajador */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 mb-5">
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
          Seleccionar Trabajador (Demo Móvil):
        </label>
        <div className="flex items-center space-x-3">
          <select
            value={selectedUser?.id || ''}
            onChange={(e) => {
              const u = users.find((usr) => usr.id === Number(e.target.value));
              if (u) setSelectedUser(u);
            }}
            disabled={isActiveShift}
            className="flex-1 bg-slate-50 border border-slate-300 text-slate-800 text-sm rounded-xl px-4 py-2.5 font-semibold focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:opacity-60"
          >
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.nombre} ({w.codigo_empleado}) - {w.cargo}
              </option>
            ))}
          </select>
        </div>
        {selectedUser && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-600 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
            <div>
              <span className="font-semibold text-slate-700">{selectedUser.nombre}</span>
              <p className="text-[11px] text-slate-500">{selectedUser.cargo}</p>
            </div>
            <span className="font-mono bg-blue-100 text-blue-700 font-bold px-2 py-0.5 rounded">
              {selectedUser.codigo_empleado}
            </span>
          </div>
        )}
      </div>

      {/* Tarjeta Principal de Turno */}
      <div
        className={`rounded-3xl p-6 shadow-md border transition-all duration-300 text-center ${
          isActiveShift
            ? 'bg-gradient-to-b from-blue-900 to-slate-900 text-white border-blue-700'
            : 'bg-white text-slate-800 border-slate-200'
        }`}
      >
        {/* Badge de Estado */}
        <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-4 border shadow-sm">
          {isActiveShift ? (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span className="text-emerald-300">Turno en Curso</span>
            </>
          ) : (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
              <span className="text-slate-500">Fuera de Jornada</span>
            </>
          )}
        </div>

        {/* Cronómetro */}
        <div className="mb-6">
          <p
            className={`text-xs font-semibold uppercase tracking-widest ${
              isActiveShift ? 'text-blue-200' : 'text-slate-400'
            }`}
          >
            Tiempo de Jornada
          </p>
          <div className="text-5xl font-black font-mono tracking-tight mt-1">
            {formatTime(shiftSeconds)}
          </div>
        </div>

        {/* Botón de Entrada / Salida */}
        <div className="mb-4">
          {isActiveShift ? (
            <button
              onClick={handleCheckOut}
              disabled={loading}
              className="w-full py-4 px-6 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-lg shadow-lg shadow-rose-600/30 flex items-center justify-center space-x-3 transition-all transform active:scale-95 disabled:opacity-60 cursor-pointer"
            >
              {loading ? (
                <RefreshCw className="w-6 h-6 animate-spin" />
              ) : (
                <>
                  <LogOut className="w-6 h-6" />
                  <span>REGISTRAR SALIDA</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleCheckIn}
              disabled={loading}
              className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-lg shadow-lg shadow-emerald-600/30 flex items-center justify-center space-x-3 transition-all transform active:scale-95 disabled:opacity-60 cursor-pointer"
            >
              {loading ? (
                <RefreshCw className="w-6 h-6 animate-spin" />
              ) : (
                <>
                  <LogIn className="w-6 h-6" />
                  <span>REGISTRAR ENTRADA</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Indicador de GPS */}
        <div
          className={`p-3 rounded-xl text-xs font-medium border flex items-center justify-center space-x-2 ${
            isActiveShift
              ? 'bg-blue-950/70 border-blue-700/60 text-blue-200'
              : 'bg-slate-50 border-slate-200 text-slate-500'
          }`}
        >
          {isActiveShift ? (
            <>
              <Navigation className="w-4 h-4 text-emerald-400 animate-spin" style={{ animationDuration: '4s' }} />
              <span>
                GPS Activo • Transmitiendo ubicación a la estación de trabajo
              </span>
            </>
          ) : (
            <>
              <ShieldCheck className="w-4 h-4 text-slate-400" />
              <span>
                GPS Apagado • Tu ubicación solo se activa al registrar entrada
              </span>
            </>
          )}
        </div>
      </div>

      {/* Geocerca & Telemetría (Solo turno activo) */}
      {isActiveShift && (
        <div className="mt-5 space-y-3">
          <div
            className={`p-4 rounded-2xl border flex items-start space-x-3 shadow-sm ${
              isInsideStation
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-200 text-amber-900'
            }`}
          >
            {isInsideStation ? (
              <ShieldCheck className="w-6 h-6 text-emerald-600 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
            )}
            <div>
              <h4 className="font-bold text-sm">
                {isInsideStation
                  ? `Dentro de Estación: ${detectedStation?.nombre}`
                  : 'Fuera de Estación de Trabajo Asignada'}
              </h4>
              <p className="text-xs mt-0.5 opacity-90">
                {isInsideStation
                  ? `Estás dentro del radio permitido de ${detectedStation?.radio_metros}m.`
                  : distanceToNearest
                  ? `Estación más cercana: ${detectedStation?.nombre} (a ~${distanceToNearest} metros).`
                  : 'Detectando proximidad a centros de operaciones...'}
              </p>
            </div>
          </div>

          {currentCoords && (
            <div className="bg-white p-4 rounded-2xl border border-slate-200 text-xs text-slate-600 shadow-sm">
              <div className="flex items-center justify-between font-bold text-slate-700 mb-2">
                <span className="flex items-center">
                  <Compass className="w-4 h-4 mr-1.5 text-blue-600" />
                  Telemetría GPS en Vivo
                </span>
                <span className="text-[11px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  Precisión ±{Math.round(currentCoords.accuracy)}m
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-slate-500 font-mono text-[11px]">
                <div className="bg-slate-50 p-2 rounded-lg">
                  <span className="block text-[10px] text-slate-400 font-sans font-medium">Latitud</span>
                  <span className="text-slate-800 font-bold">{currentCoords.latitude.toFixed(6)}</span>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg">
                  <span className="block text-[10px] text-slate-400 font-sans font-medium">Longitud</span>
                  <span className="text-slate-800 font-bold">{currentCoords.longitude.toFixed(6)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Barra de simulación para pruebas */}
          <div className="bg-blue-50 border border-blue-200 p-3.5 rounded-2xl text-xs text-blue-900 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold flex items-center">
                <Smartphone className="w-4 h-4 mr-1 text-blue-600" />
                Simulador de Movimiento (Para Pruebas):
              </span>
            </div>
            <p className="text-[11px] text-blue-700 mb-2">
              Haz clic en cualquier estación para teletransportar al trabajador y ver el cambio en el mapa admin en vivo:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {workstations.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => handleSimulateMove(ws.id)}
                  className="px-2.5 py-1 text-[11px] bg-white border border-blue-300 hover:bg-blue-600 hover:text-white rounded-lg font-semibold text-blue-800 transition shadow-sm cursor-pointer"
                >
                  📍 {ws.nombre.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Caja Informativa PWA */}
      <div className="mt-6 bg-slate-100 p-4 rounded-2xl border border-slate-200 text-xs text-slate-600">
        <div className="flex items-center space-x-2 font-bold text-slate-800 mb-1">
          <Info className="w-4 h-4 text-blue-600" />
          <span>Integración PWA y CapacitorJS</span>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Esta aplicación está lista para instalarse como <strong>PWA en el navegador móvil</strong> o empaquetarse con <strong>CapacitorJS</strong> para Android/iOS con permisos de geolocalización de alta precisión en segundo plano.
        </p>
      </div>
    </div>
  );
};
