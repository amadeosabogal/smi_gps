import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Circle, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { EstacionTrabajo, DatosTrabajadorEnVivo } from '../types';
import { ShieldCheck, AlertTriangle, Clock, Crosshair } from 'lucide-react';

interface LiveMapProps {
  workstations: EstacionTrabajo[];
  activeWorkers: DatosTrabajadorEnVivo[];
  selectedWorker?: DatosTrabajadorEnVivo | null;
  onSelectWorker?: (worker: DatosTrabajadorEnVivo) => void;
}

// Controlador para centrar y animar el mapa cuando se selecciona un trabajador
const MapFlyTo: React.FC<{ selectedWorker?: DatosTrabajadorEnVivo | null }> = ({ selectedWorker }) => {
  const map = useMap();
  useEffect(() => {
    if (selectedWorker?.latitud && selectedWorker?.longitud) {
      map.flyTo([selectedWorker.latitud, selectedWorker.longitud], 18, {
        animate: true,
        duration: 1.2,
      });
    }
  }, [selectedWorker, map]);
  return null;
};

// Icono personalizado con iniciales y estado
function createWorkerIcon(worker: DatosTrabajadorEnVivo) {
  const isInside = worker.dentro_de_estacion;
  const borderColor = isInside ? '#10B981' : '#F59E0B';

  const initials = worker.nombre_usuario
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();

  const html = `
    <div class="relative flex items-center justify-center">
      <div class="absolute w-10 h-10 rounded-full bg-blue-500/20 animate-ping"></div>
      <div class="w-8 h-8 rounded-full bg-slate-900 border-2 shadow-lg flex items-center justify-center font-bold text-[11px] text-white select-none transition-transform hover:scale-110" style="border-color: ${borderColor};">
        ${initials}
      </div>
      <div class="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white flex items-center justify-center text-[8px] text-white font-bold" style="background-color: ${borderColor};">
        ${isInside ? '✓' : '!'}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-worker-marker',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -20],
  });
}

export const LiveMap: React.FC<LiveMapProps> = ({
  workstations,
  activeWorkers,
  selectedWorker,
  onSelectWorker,
}) => {
  // Centro por defecto (coordenadas de la primera estación o planta central)
  const defaultCenter: [number, number] = workstations.length > 0
    ? [workstations[0].latitud, workstations[0].longitud]
    : [-12.046374, -77.042793];

  return (
    <div className="relative w-full h-[550px] rounded-2xl overflow-hidden shadow-md border border-slate-200">
      <MapContainer
        center={defaultCenter}
        zoom={17}
        scrollWheelZoom={true}
        className="w-full h-full"
      >
        <MapFlyTo selectedWorker={selectedWorker} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Círculos de Geocerca de cada Estación de Trabajo */}
        {workstations.map((estacion) => (
          <React.Fragment key={`ws-${estacion.id}`}>
            <Circle
              center={[estacion.latitud, estacion.longitud]}
              radius={estacion.radio_metros}
              pathOptions={{
                color: estacion.color || '#3B82F6',
                fillColor: estacion.color || '#3B82F6',
                fillOpacity: 0.15,
                weight: 2,
                dashArray: '4, 4',
              }}
            >
              <Popup>
                <div className="p-1 font-sans">
                  <div className="flex items-center space-x-1.5 font-bold text-slate-800 text-sm">
                    <span
                      className="w-3 h-3 rounded-full inline-block"
                      style={{ backgroundColor: estacion.color }}
                    />
                    <span>{estacion.nombre}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Código: <span className="font-semibold text-slate-700">{estacion.codigo}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    Radio de Geocerca: <span className="font-semibold text-blue-600">{estacion.radio_metros} metros</span>
                  </p>
                  {estacion.descripcion && (
                    <p className="text-xs text-slate-600 italic mt-1 bg-slate-100 p-1.5 rounded">
                      {estacion.descripcion}
                    </p>
                  )}
                </div>
              </Popup>
            </Circle>

            {/* Marcador Central de la Estación con Píldora Súper Legible */}
            <Marker
              position={[estacion.latitud, estacion.longitud]}
              icon={L.divIcon({
                html: `
                  <div class="inline-flex items-center space-x-1.5 bg-white border-2 px-3 py-1 rounded-full shadow-lg whitespace-nowrap text-xs font-black text-slate-900 -translate-x-1/2 -translate-y-full" style="border-color: ${estacion.color};">
                    <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background-color: ${estacion.color}"></span>
                    <span>${estacion.codigo} • ${estacion.nombre}</span>
                  </div>
                `,
                className: 'station-badge-pill',
                iconSize: [0, 0],
              })}
            />
          </React.Fragment>
        ))}

        {/* Marcadores de Trabajadores en Vivo */}
        {activeWorkers.map((trabajador) => {
          if (!trabajador.latitud || !trabajador.longitud) return null;

          return (
            <Marker
              key={`worker-${trabajador.usuario_id}`}
              position={[trabajador.latitud, trabajador.longitud]}
              icon={createWorkerIcon(trabajador)}
              eventHandlers={{
                click: () => onSelectWorker && onSelectWorker(trabajador),
              }}
            >
              <Popup>
                <div className="p-2 font-sans min-w-[220px]">
                  {/* Cabecera del Trabajador */}
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-bold text-sm text-slate-900 leading-tight">
                        {trabajador.nombre_usuario}
                      </h4>
                      <p className="text-xs text-slate-500 font-medium">{trabajador.cargo}</p>
                    </div>
                    <span className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-mono font-bold">
                      {trabajador.codigo_empleado}
                    </span>
                  </div>

                  {/* Estado de Geocerca */}
                  <div className="mt-2.5">
                    {trabajador.dentro_de_estacion ? (
                      <div className="flex items-center space-x-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-lg font-semibold">
                        <ShieldCheck className="w-4 h-4 text-emerald-600" />
                        <span>En Estación: {trabajador.estacion_nombre}</span>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg font-semibold">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <span>Fuera de estación asignada</span>
                      </div>
                    )}
                  </div>

                  {/* Detalles */}
                  <div className="mt-2 space-y-1 text-xs text-slate-600 border-t border-slate-100 pt-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center text-slate-500">
                        <Clock className="w-3.5 h-3.5 mr-1" />
                        Ingreso:
                      </span>
                      <span className="font-medium text-slate-800">
                        {trabajador.hora_ingreso
                          ? new Date(trabajador.hora_ingreso).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '--:--'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="flex items-center text-slate-500">
                        <Crosshair className="w-3.5 h-3.5 mr-1" />
                        Precisión GPS:
                      </span>
                      <span className="font-medium text-blue-600">
                        ±{Math.round(trabajador.precision || 10)}m
                      </span>
                    </div>

                    {trabajador.foto_ingreso_url && (
                      <div className="mt-2 pt-2 border-t border-slate-100 text-center">
                        <span className="text-[10px] font-bold text-slate-500 block mb-1">📸 Evidencia de Ingreso</span>
                        <img
                          src={trabajador.foto_ingreso_url}
                          alt="Evidencia Ingreso"
                          className="w-full h-24 object-cover rounded-lg border border-slate-200"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* Leyenda */}
      <div className="absolute bottom-4 right-4 z-[400] bg-white/95 backdrop-blur-sm p-3 rounded-xl shadow-lg border border-slate-200/80 text-xs text-slate-700 space-y-1.5">
        <p className="font-bold text-[11px] text-slate-400 uppercase tracking-wider mb-1">Leyenda en Vivo</p>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full bg-emerald-500 border border-white shadow-sm inline-block"></span>
          <span>Trabajador en Estación</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full bg-amber-500 border border-white shadow-sm inline-block"></span>
          <span>Trabajador fuera de Estación</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full border-2 border-dashed border-blue-500 inline-block"></span>
          <span>Radio de Estación (Geocerca)</span>
        </div>
      </div>
    </div>
  );
};
