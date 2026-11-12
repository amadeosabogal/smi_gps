import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Circle, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { EstacionTrabajo, DatosTrabajadorEnVivo } from '../types';
import { AuthImage } from './AuthImage';
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
  const borderColor = isInside ? '#1f7a4d' : '#b45f06';

  const initials = worker.nombre_usuario
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();

  // Insignia cuadrada con iniciales: azul de la marca y borde del color del estado
  const html = `
    <div style="width:34px;height:34px;background:#1c42ba;border:3px solid ${borderColor};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;font-family:Archivo,sans-serif;box-shadow:0 1px 3px rgba(15,23,42,.35);">
      ${initials}
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-worker-marker',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
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
                  <div style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #cbd5e1;border-left:4px solid ${estacion.color};padding:3px 8px;white-space:nowrap;font-size:12px;font-weight:600;color:#0f172a;font-family:Archivo,sans-serif;transform:translate(-50%,-100%);box-shadow:0 1px 2px rgba(15,23,42,.12);">${estacion.codigo} · ${estacion.nombre}</div>
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
                    <span className="text-xs bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-mono font-bold">
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

                    {trabajador.tiene_foto_ingreso && trabajador.asistencia_id && (
                      <div className="mt-2 pt-2 border-t border-slate-100 text-center">
                        <span className="text-xs font-bold text-slate-500 block mb-1">Evidencia de Ingreso</span>
                        <AuthImage
                          path={`/photos/attendance/${trabajador.asistencia_id}/in`}
                          alt="Evidencia Ingreso"
                          eager
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
      <div className="absolute bottom-4 right-4 z-[400] space-y-1.5 border border-slate-300 bg-white p-3 text-sm text-slate-700 shadow-md">
        <p className="mb-1 text-sm font-semibold text-slate-900">Leyenda</p>
        <div className="flex items-center space-x-2">
          <span className="inline-block h-3 w-3 bg-green-700"></span>
          <span>Trabajador en su estación</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="inline-block h-3 w-3 bg-amber-600"></span>
          <span>Trabajador fuera de zona</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="inline-block h-3 w-3 border-2 border-dashed border-brand-600"></span>
          <span>Radio de la estación (geocerca)</span>
        </div>
      </div>
    </div>
  );
};
