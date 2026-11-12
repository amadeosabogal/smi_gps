import React, { useState } from 'react';
import type { EstacionTrabajo, ResumenDashboard, DatosTrabajadorEnVivo, RegistroAsistencia } from '../types';
import { LiveMap } from './LiveMap';
import { api } from '../services/api';
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
  FileSpreadsheet
} from 'lucide-react';

interface AdminDashboardProps {
  summary: ResumenDashboard;
  workers: DatosTrabajadorEnVivo[];
  workstations: EstacionTrabajo[];
  attendanceLogs: RegistroAsistencia[];
  onRefresh: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  summary,
  workers,
  workstations,
  attendanceLogs,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<'map' | 'logs' | 'stations'>('map');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedWorker, setSelectedWorker] = useState<DatosTrabajadorEnVivo | null>(null);

  // Modal para nueva estación
  const [showNewStationModal, setShowNewStationModal] = useState<boolean>(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newLat, setNewLat] = useState('-12.0463');
  const [newLng, setNewLng] = useState('-77.0427');
  const [newRadius, setNewRadius] = useState('50');
  const [newColor, setNewColor] = useState('#3B82F6');
  const [isSavingStation, setIsSavingStation] = useState(false);

  // Filtrar trabajadores activos
  const activeWorkers = workers.filter((w) => w.estado_asistencia === 'activo');

  // Filtrar lista de personal
  const filteredWorkers = workers.filter((w) =>
    w.nombre_usuario.toLowerCase().includes(searchTerm.toLowerCase()) ||
    w.codigo_empleado.toLowerCase().includes(searchTerm.toLowerCase()) ||
    w.cargo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Filtrar registros de asistencia
  const filteredLogs = attendanceLogs.filter((log) =>
    (log.nombre_usuario || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (log.codigo_empleado || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Exportar a CSV
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

  // Crear estación de trabajo en SQL Server
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
      onRefresh();
    } catch (err: any) {
      alert(err.message || 'Error al guardar la estación');
    } finally {
      setIsSavingStation(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 font-sans">
      {/* Tarjetas de Métricas Superiores */}
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
            <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wider">En Estación de Trabajo</p>
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

      {/* Navegación y Búsqueda */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm mb-6">
        <div className="flex items-center space-x-1">
          <button
            onClick={() => setActiveTab('map')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'map'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <MapPin className="w-4 h-4" />
            <span>Mapa en Tiempo Real</span>
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'logs'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Historial Asistencia ({attendanceLogs.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('stations')}
            className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'stations'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-600 hover:bg-slate-100'
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

      {/* Pestaña 1: Mapa en Vivo */}
      {activeTab === 'map' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <LiveMap
              workstations={workstations}
              activeWorkers={activeWorkers}
              onSelectWorker={(w) => setSelectedWorker(w)}
            />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col h-[550px]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-bold text-sm text-slate-800">Personal en Turno ({activeWorkers.length})</h3>
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

      {/* Pestaña 2: Historial de Asistencia */}
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
                  <th className="px-4 py-3">Salida (GPS)</th>
                  <th className="px-4 py-3">Estación Salida</th>
                  <th className="px-4 py-3 text-right">Horas</th>
                  <th className="px-4 py-3 text-center">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                      No hay registros de asistencia aún. Haz pruebas registrando entrada en la Vista Trabajador.
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

      {/* Pestaña 3: Estaciones de Trabajo */}
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

      {/* Modal: Nueva Estación */}
      {showNewStationModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <h3 className="font-bold text-lg text-slate-900 mb-4">Nueva Estación de Trabajo (Geocerca)</h3>
            <form onSubmit={handleCreateStation} className="space-y-3 text-xs">
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
                  className="px-4 py-2 font-bold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSavingStation}
                  className="px-5 py-2 font-bold bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-md transition disabled:opacity-60"
                >
                  {isSavingStation ? 'Guardando en BD...' : 'Guardar Estación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
