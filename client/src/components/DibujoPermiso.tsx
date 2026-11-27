import React from 'react';
import { MapPin } from 'lucide-react';
import type { IdPaso } from '../services/pasosPermisos';

// Dibujos de las ventanas de Android que muestran dónde tocar. Son una guía: cada teléfono las pinta algo distinto.
// La opción resaltada late (animación "toque-objetivo" en index.css).

const Objetivo: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={`toque-objetivo relative border-2 border-amber-400 bg-amber-50 font-semibold text-slate-900 ${className ?? ''}`}>
    {children}
    <span className="toque-dedo absolute -right-2 top-1/2 h-5 w-5 rounded-full border-2 border-white bg-amber-400" />
  </div>
);

const Ventana: React.FC<{ titulo: string; children: React.ReactNode }> = ({ titulo, children }) => (
  <div className="rounded-2xl border border-slate-300 bg-white p-3">
    <p className="mb-2 text-center text-sm text-slate-800">{titulo}</p>
    <div className="space-y-1.5 text-center text-sm text-slate-500">{children}</div>
  </div>
);

const Opcion: React.FC<{ texto: string; elegida?: boolean }> = ({ texto, elegida }) => {
  const fila = (
    <span className="flex items-center gap-3 px-3 py-2 text-left">
      <span className={`h-4 w-4 flex-shrink-0 rounded-full border-2 ${elegida ? 'border-brand-600 bg-brand-600' : 'border-slate-400'}`} />
      {texto}
    </span>
  );
  return elegida ? <Objetivo className="rounded-lg">{fila}</Objetivo> : <div className="px-0.5">{fila}</div>;
};

const Interruptor: React.FC<{ texto: string }> = ({ texto }) => (
  <Objetivo className="rounded-lg">
    <span className="flex items-center justify-between gap-3 px-3 py-3 text-left">
      {texto}
      <span className="relative h-6 w-11 flex-shrink-0 rounded-full bg-brand-600">
        <span className="toque-interruptor absolute top-1 h-4 w-4 rounded-full bg-white" />
      </span>
    </span>
  </Objetivo>
);

export const DibujoPermiso: React.FC<{ paso: IdPaso; samsung?: boolean }> = ({ paso, samsung }) => (
  <div className="mx-auto w-full max-w-xs bg-slate-100 p-3" aria-hidden="true">
    {paso === 'ubicacion' && <Interruptor texto="Ubicación" />}
    {paso === 'precisa' && (
      <Ventana titulo="¿Permitir que la app acceda a la ubicación?">
        <div className="flex justify-center gap-6 pb-1">
          <Objetivo className="rounded-lg px-3 py-1.5">
            <MapPin className="mx-auto h-6 w-6 text-brand-600" />
            Precisa
          </Objetivo>
          <div className="px-3 py-1.5">
            <MapPin className="mx-auto h-6 w-6 text-slate-300" />
            Aproximada
          </div>
        </div>
        <Objetivo className="rounded-lg py-2">Mientras la app está en uso</Objetivo>
        <p>Solo esta vez</p>
        <p>No permitir</p>
      </Ventana>
    )}
    {paso === 'todo' && (
      <Ventana titulo="Permiso de ubicación">
        <Opcion texto="Permitir todo el tiempo" elegida />
        <Opcion texto="Permitir solo con la app en uso" />
        <Opcion texto="Preguntar siempre" />
        <Opcion texto="No permitir" />
      </Ventana>
    )}
    {paso === 'notificaciones' && (
      <Ventana titulo="¿Permitir que la app envíe notificaciones?">
        <Objetivo className="rounded-lg py-2">Permitir</Objetivo>
        <p>No permitir</p>
      </Ventana>
    )}
    {paso === 'bateria' && (
      <Ventana titulo="¿Permitir que la app se ejecute siempre en segundo plano?">
        <Objetivo className="rounded-lg py-2">Permitir</Objetivo>
        <p>Denegar</p>
      </Ventana>
    )}
    {paso === 'fabricante' &&
      (samsung ? (
        <Ventana titulo="Apps en suspensión">
          <Objetivo className="rounded-lg py-3">Quitar esta app de la lista</Objetivo>
        </Ventana>
      ) : (
        <Interruptor texto="Inicio automático" />
      ))}
  </div>
);
