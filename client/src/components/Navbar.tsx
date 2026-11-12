import React from 'react';
import { MapPin, Smartphone, Monitor } from 'lucide-react';

interface NavbarProps {
  currentView: 'worker' | 'admin';
  setCurrentView: (view: 'worker' | 'admin') => void;
  isSocketConnected: boolean;
  activeShiftCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  setCurrentView,
  isSocketConnected,
  activeShiftCount,
}) => {
  return (
    <header className="bg-slate-900 border-b border-slate-800 text-white sticky top-0 z-50 shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <MapPin className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-extrabold text-xl tracking-tight text-white">SMI</span>
              <span className="text-xs bg-blue-500/20 text-blue-300 font-semibold px-2 py-0.5 rounded-full border border-blue-500/30">
                GPS & Geocercas
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-medium">Control de Asistencia en Tiempo Real</p>
          </div>
        </div>

        {/* View Switcher Pills */}
        <div className="flex items-center bg-slate-800/80 p-1 rounded-xl border border-slate-700/60 shadow-inner">
          <button
            onClick={() => setCurrentView('worker')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
              currentView === 'worker'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span className="hidden sm:inline">Vista Trabajador</span>
            <span className="sm:hidden">Móvil</span>
          </button>
          <button
            onClick={() => setCurrentView('admin')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 relative ${
              currentView === 'admin'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
          >
            <Monitor className="w-4 h-4" />
            <span className="hidden sm:inline">Panel Administrativo</span>
            <span className="sm:hidden">Admin</span>
            {activeShiftCount > 0 && (
              <span className="ml-1 px-1.5 py-0.2 text-[10px] bg-emerald-500 text-white font-bold rounded-full">
                {activeShiftCount}
              </span>
            )}
          </button>
        </div>

        {/* Status indicator */}
        <div className="hidden md:flex items-center space-x-3 text-xs">
          <div className="flex items-center space-x-2 bg-slate-800/60 px-3 py-1.5 rounded-lg border border-slate-700">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                isSocketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="text-slate-300 font-medium">
              {isSocketConnected ? 'Enlace en Vivo' : 'Desconectado'}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};
