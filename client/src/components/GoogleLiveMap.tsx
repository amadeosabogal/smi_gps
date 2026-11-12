import React, { useEffect, useRef, useState } from 'react';
import { setOptions, importLibrary } from '@googlemaps/js-api-loader';
import type { EstacionTrabajo, DatosTrabajadorEnVivo } from '../types';
import { Key, AlertTriangle, Layers, ExternalLink } from 'lucide-react';

function escapeXml(unsafe: string) {
  return (unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createStationBadgeSvg(codigo: string, nombre: string, color: string) {
  const label = `${codigo} • ${nombre}`;
  const charWidth = 7.5;
  const pillWidth = Math.max(140, Math.min(270, label.length * charWidth + 34));
  const pillHeight = 28;
  const pointerHeight = 6;
  const totalHeight = pillHeight + pointerHeight + 6;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${pillWidth}" height="${totalHeight}" viewBox="0 0 ${pillWidth} ${totalHeight}">
      <defs>
        <filter id="shadow" x="-15%" y="-15%" width="130%" height="135%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.35" />
        </filter>
      </defs>
      <g filter="url(#shadow)">
        <rect x="3" y="3" width="${pillWidth - 6}" height="${pillHeight}" rx="${pillHeight / 2}" fill="#FFFFFF" stroke="${color || '#2563EB'}" stroke-width="2.5" />
        <polygon points="${pillWidth / 2 - 5},${pillHeight + 2} ${pillWidth / 2 + 5},${pillHeight + 2} ${pillWidth / 2},${pillHeight + pointerHeight + 2}" fill="${color || '#2563EB'}" />
        <circle cx="16" cy="${pillHeight / 2 + 3}" r="5" fill="${color || '#2563EB'}" stroke="#FFFFFF" stroke-width="1.5" />
        <text x="27" y="${pillHeight / 2 + 7.5}" fill="#0F172A" font-size="11.5" font-family="Archivo, Arial, sans-serif" font-weight="900" letter-spacing="-0.2">
          ${escapeXml(label.length > 30 ? label.slice(0, 28) + '...' : label)}
        </text>
      </g>
    </svg>
  `;
}

interface GoogleLiveMapProps {
  workstations: EstacionTrabajo[];
  activeWorkers: DatosTrabajadorEnVivo[];
  selectedWorker?: DatosTrabajadorEnVivo | null;
  onSelectWorker?: (worker: DatosTrabajadorEnVivo) => void;
  onMapClick?: (lat: number, lng: number) => void;
}

export const GoogleLiveMap: React.FC<GoogleLiveMapProps> = ({
  workstations,
  activeWorkers,
  selectedWorker,
  onSelectWorker,
  onMapClick,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const circlesRef = useRef<google.maps.Circle[]>([]);
  const stationMarkersRef = useRef<google.maps.Marker[]>([]);
  const workerMarkersRef = useRef<google.maps.Marker[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  // API Key from .env or localStorage
  const envKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem('smi_google_maps_key') || envKey || '';
  });
  const [tempKeyInput, setTempKeyInput] = useState<string>('');
  const [showKeyModal, setShowKeyModal] = useState<boolean>(!apiKey);
  const [mapLoaded, setMapLoaded] = useState<boolean>(false);
  const [mapError, setMapError] = useState<string | null>(null);

  // Default center
  const defaultCenter = workstations.length > 0
    ? { lat: workstations[0].latitud, lng: workstations[0].longitud }
    : { lat: -12.046374, lng: -77.042793 };

  // Guardar clave API
  const handleSaveApiKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempKeyInput.trim()) return;
    const cleanKey = tempKeyInput.trim();
    setApiKey(cleanKey);
    localStorage.setItem('smi_google_maps_key', cleanKey);
    setShowKeyModal(false);
    setMapError(null);
  };

  // 1. Cargar Google Maps con importLibrary
  useEffect(() => {
    if (!apiKey || !mapContainerRef.current) return;

    let isMounted = true;

    async function loadGoogleMaps() {
      try {
        setOptions({
          key: apiKey,
          v: 'weekly',
        });

        const { Map, InfoWindow } = (await importLibrary('maps')) as google.maps.MapsLibrary;

        if (!isMounted || !mapContainerRef.current) return;

        const map = new Map(mapContainerRef.current, {
          center: defaultCenter,
          zoom: 17,
          mapTypeId: 'roadmap',
          mapTypeControl: true,
          streetViewControl: true,
          fullscreenControl: true,
          zoomControl: true,
        });

        map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (e.latLng && onMapClick) {
            onMapClick(e.latLng.lat(), e.latLng.lng());
          }
        });

        infoWindowRef.current = new InfoWindow();
        mapInstanceRef.current = map;
        setMapLoaded(true);
        setMapError(null);
      } catch (err: any) {
        console.error('Error cargando Google Maps API:', err);
        setMapError(
          'Error al cargar Google Maps. Verifica que la API Key sea válida y tenga habilitada la "Maps JavaScript API".'
        );
      }
    }

    loadGoogleMaps();

    return () => {
      isMounted = false;
    };
  }, [apiKey]);

  // 2. Renderizar Estaciones (Geocercas Circulares & Etiquetas)
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || !window.google) return;
    const map = mapInstanceRef.current;

    circlesRef.current.forEach((c) => c.setMap(null));
    circlesRef.current = [];
    stationMarkersRef.current.forEach((m) => m.setMap(null));
    stationMarkersRef.current = [];

    workstations.forEach((station) => {
      const circle = new window.google.maps.Circle({
        strokeColor: station.color || '#3B82F6',
        strokeOpacity: 0.85,
        strokeWeight: 2,
        fillColor: station.color || '#3B82F6',
        fillOpacity: 0.18,
        map,
        center: { lat: station.latitud, lng: station.longitud },
        radius: station.radio_metros,
      });

      const labelText = `${station.codigo} • ${station.nombre}`;
      const charWidth = 7.5;
      const pillWidth = Math.max(140, Math.min(270, labelText.length * charWidth + 34));
      const totalHeight = 28 + 6 + 6;
      const svg = createStationBadgeSvg(station.codigo, station.nombre, station.color);

      const marker = new window.google.maps.Marker({
        position: { lat: station.latitud, lng: station.longitud },
        map,
        title: `${station.codigo}: ${station.nombre}`,
        icon: {
          url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
          scaledSize: new window.google.maps.Size(pillWidth, totalHeight),
          anchor: new window.google.maps.Point(pillWidth / 2, totalHeight - 2),
        },
        zIndex: 100,
      });

      const content = `
        <div style="font-family: Archivo, sans-serif; padding: 6px; min-width: 180px;">
          <div style="display: flex; align-items: center; gap: 6px; font-weight: bold; font-size: 13px; color: #0F172A;">
            <span style="width: 10px; height: 10px; border-radius: 50%; background-color: ${station.color};"></span>
            <span>${station.nombre}</span>
          </div>
          <p style="font-size: 11px; color: #64748B; margin-top: 4px;">
            Código: <strong style="color: #1E293B;">${station.codigo}</strong>
          </p>
          <p style="font-size: 11px; color: #64748B;">
            Radio de Geocerca: <strong style="color: #2563EB;">${station.radio_metros} metros</strong>
          </p>
          ${
            station.descripcion
              ? `<p style="font-size: 10px; color: #475569; background: #F1F5F9; padding: 4px; border-radius: 4px; margin-top: 4px;">${station.descripcion}</p>`
              : ''
          }
        </div>
      `;

      circle.addListener('click', () => {
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(content);
          infoWindowRef.current.setPosition({ lat: station.latitud, lng: station.longitud });
          infoWindowRef.current.open(map);
        }
      });

      marker.addListener('click', () => {
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(content);
          infoWindowRef.current.open(map, marker);
        }
      });

      circlesRef.current.push(circle);
      stationMarkersRef.current.push(marker);
    });
  }, [mapLoaded, workstations]);

  // 3. Renderizar Trabajadores Activos
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || !window.google) return;
    const map = mapInstanceRef.current;

    workerMarkersRef.current.forEach((m) => m.setMap(null));
    workerMarkersRef.current = [];

    activeWorkers.forEach((worker) => {
      if (!worker.latitud || !worker.longitud) return;

      const isInside = worker.dentro_de_estacion;
      const markerColor = isInside ? '#10B981' : '#F59E0B';
      const initials = worker.nombre_usuario
        .split(' ')
        .slice(0, 2)
        .map((n) => n[0])
        .join('')
        .toUpperCase();

      const svgIcon = {
        url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="18" fill="${markerColor}" fill-opacity="0.25" stroke="${markerColor}" stroke-width="1.5" />
            <circle cx="20" cy="20" r="13" fill="#0F172A" stroke="${markerColor}" stroke-width="2.5" />
            <text x="20" y="24" fill="#FFFFFF" font-size="10" font-family="Archivo, sans-serif" font-weight="900" text-anchor="middle">${initials}</text>
            <circle cx="31" cy="9" r="5" fill="${markerColor}" stroke="#FFFFFF" stroke-width="1.5" />
          </svg>
        `)}`,
        scaledSize: new window.google.maps.Size(40, 40),
        anchor: new window.google.maps.Point(20, 20),
      };

      const marker = new window.google.maps.Marker({
        position: { lat: worker.latitud, lng: worker.longitud },
        map,
        title: worker.nombre_usuario,
        icon: svgIcon,
        zIndex: 1000,
      });

      const horaIngreso = worker.hora_ingreso
        ? new Date(worker.hora_ingreso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '--:--';

      const workerContent = `
        <div style="font-family: Archivo, sans-serif; padding: 6px; min-width: 220px;">
          <div style="display: flex; justify-content: space-between; align-items: start;">
            <div>
              <h4 style="font-size: 13px; font-weight: 800; color: #0F172A; margin: 0;">${worker.nombre_usuario}</h4>
              <p style="font-size: 11px; color: #64748B; margin: 2px 0 0 0;">${worker.cargo}</p>
            </div>
            <span style="font-size: 10px; font-weight: bold; background: #F1F5F9; color: #334155; padding: 2px 6px; border-radius: 4px; font-family: monospace;">
              ${worker.codigo_empleado}
            </span>
          </div>

          <div style="margin-top: 8px;">
            ${
              isInside
                ? `<div style="display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: bold; color: #047857; background: #ECFDF5; border: 1px solid #A7F3D0; padding: 4px 8px; border-radius: 6px;">
                    ✓ En Estación: ${worker.estacion_nombre || 'Asignada'}
                   </div>`
                : `<div style="display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: bold; color: #B45309; background: #FFFBEB; border: 1px solid #FDE68A; padding: 4px 8px; border-radius: 6px;">
                    ⚠ Fuera de estación asignada
                   </div>`
            }
          </div>

          <div style="margin-top: 8px; border-top: 1px solid #F1F5F9; padding-top: 6px; font-size: 11px; color: #64748B;">
            <div style="display: flex; justify-content: space-between;">
              <span>Ingreso:</span>
              <strong style="color: #0F172A;">${horaIngreso}</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 2px;">
              <span>Precisión GPS:</span>
              <strong style="color: #2563EB;">±${Math.round(worker.precision || 10)}m</strong>
            </div>
          </div>

          ${
            worker.foto_ingreso_url
              ? `<div style="margin-top: 8px; border-top: 1px solid #F1F5F9; padding-top: 6px; text-align: center;">
                  <span style="font-size: 10px; font-weight: bold; color: #475569; display: block; margin-bottom: 4px;">📸 Evidencia Fotográfica de Entrada</span>
                  <img src="${worker.foto_ingreso_url}" style="width: 100%; max-height: 120px; object-fit: cover; border-radius: 8px; border: 1px solid #E2E8F0;" />
                </div>`
              : ''
          }
        </div>
      `;

      marker.addListener('click', () => {
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(workerContent);
          infoWindowRef.current.open(map, marker);
        }
        if (onSelectWorker) onSelectWorker(worker);
      });

      workerMarkersRef.current.push(marker);
    });
  }, [mapLoaded, activeWorkers, onSelectWorker]);

  // 4. Centrar en Trabajador Seleccionado
  useEffect(() => {
    if (!mapLoaded || !mapInstanceRef.current || !selectedWorker) return;
    if (selectedWorker.latitud && selectedWorker.longitud) {
      mapInstanceRef.current.panTo({
        lat: selectedWorker.latitud,
        lng: selectedWorker.longitud,
      });
      mapInstanceRef.current.setZoom(18);
    }
  }, [mapLoaded, selectedWorker]);

  return (
    <div className="relative w-full h-[550px] rounded-2xl overflow-hidden shadow-md border border-slate-200">
      <div ref={mapContainerRef} className="w-full h-full bg-slate-100" />

      {/* Botón superior de configuración */}
      <div className="absolute top-3 left-3 z-10 flex items-center space-x-2">
        <button
          onClick={() => setShowKeyModal(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 bg-white/95 backdrop-blur-sm hover:bg-white text-slate-700 text-xs font-bold rounded-xl shadow-md border border-slate-200 transition cursor-pointer"
        >
          <Key className="w-3.5 h-3.5 text-blue-600" />
          <span>{apiKey ? 'API Key Google' : 'Configurar API Key'}</span>
        </button>

        <span className="hidden sm:inline-flex items-center space-x-1 px-2.5 py-1.5 bg-slate-900/85 backdrop-blur-sm text-white text-[11px] font-semibold rounded-xl shadow">
          <Layers className="w-3 h-3 text-blue-400 mr-1" />
          Google Maps Oficial
        </span>
      </div>

      {/* Leyenda */}
      <div className="absolute bottom-5 right-5 z-10 bg-white/95 backdrop-blur-sm p-3 rounded-xl shadow-lg border border-slate-200 text-xs text-slate-700 space-y-1.5 pointer-events-auto">
        <p className="font-bold text-[10px] text-slate-400 uppercase tracking-wider mb-1">
          Leyenda en Vivo
        </p>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full bg-emerald-500 border border-white shadow-sm inline-block"></span>
          <span>Trabajador en Estación</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full bg-amber-500 border border-white shadow-sm inline-block"></span>
          <span>Trabajador fuera de Estación</span>
        </div>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full border-2 border-blue-500 inline-block"></span>
          <span>Geocerca de Estación</span>
        </div>
      </div>

      {/* Error de API Key */}
      {mapError && (
        <div className="absolute inset-0 z-20 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-6 text-center">
          <div className="bg-white rounded-3xl p-6 max-w-md shadow-2xl">
            <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-2" />
            <h3 className="font-extrabold text-base text-slate-900">Configuración de Google Maps API</h3>
            <p className="text-xs text-slate-600 mt-2 leading-relaxed">{mapError}</p>
            <div className="mt-4 flex justify-center space-x-2">
              <button
                onClick={() => setShowKeyModal(true)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow cursor-pointer"
              >
                Ingresar / Cambiar API Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal para ingresar API Key */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center space-x-2.5 mb-2">
              <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white">
                <Key className="w-5 h-5" />
              </div>
              <h3 className="font-extrabold text-base text-slate-900">Google Maps JavaScript API</h3>
            </div>
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">
              Introduce tu <strong>API Key oficial de Google Maps</strong> para habilitar las capas satelitales, Street View y renderizado oficial de Google:
            </p>

            <form onSubmit={handleSaveApiKey} className="space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Google Maps API Key:
                </label>
                <input
                  type="text"
                  required
                  placeholder="AIzaSy..."
                  value={tempKeyInput || apiKey}
                  onChange={(e) => setTempKeyInput(e.target.value)}
                  className="w-full p-2.5 bg-slate-50 border border-slate-300 font-mono text-xs rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              </div>

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-600 space-y-1">
                <p className="font-semibold text-slate-800">Requisitos en Google Cloud Console:</p>
                <p>1. Habilitar la <strong>Maps JavaScript API</strong>.</p>
                <p>2. Si tienes restricciones de origen, permite <code>localhost:*</code> y tu IP local.</p>
                <a
                  href="https://console.cloud.google.com/google/maps-apis/overview"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline font-semibold flex items-center pt-1"
                >
                  <span>Ir a Google Cloud Console</span>
                  <ExternalLink className="w-3 h-3 ml-1" />
                </a>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-3">
                {apiKey && (
                  <button
                    type="button"
                    onClick={() => setShowKeyModal(false)}
                    className="px-4 py-2 font-bold text-slate-600 hover:bg-slate-100 rounded-xl text-xs cursor-pointer"
                  >
                    Cerrar
                  </button>
                )}
                <button
                  type="submit"
                  className="px-5 py-2 font-extrabold bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-md text-xs cursor-pointer"
                >
                  Guardar y Cargar Mapa
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
