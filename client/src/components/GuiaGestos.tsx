import React from 'react';
import { TEXTO_RETO, TODOS_LOS_RETOS, type TipoReto } from '../services/livenessChallenges';

// Caritas animadas que muestran cómo se hace cada gesto de la prueba de vida. Son dibujos (SVG + CSS):
// no pesan, no necesitan internet y se ven igual en cualquier teléfono. Las animaciones están en index.css.
// La vista es como un espejo: "a su izquierda" mueve la cara hacia la izquierda de la pantalla, igual que la flecha.

export type Gesto = 'inicio' | TipoReto;

const ojo = (x: number, parpadea: boolean) => (
  <ellipse className={`gesto-pieza ${parpadea ? 'gesto-parpadeo' : ''}`} cx={x} cy={50} rx={5} ry={6} fill="currentColor" />
);

const linea = { stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };

export const CaraGesto: React.FC<{ gesto: Gesto; className?: string }> = ({ gesto, className }) => (
  <svg viewBox="0 0 120 120" className={`text-slate-800 ${className ?? ''}`} aria-hidden="true">
    {gesto === 'inicio' && (
      <rect x={14} y={4} width={92} height={112} fill="none" className="stroke-brand-600" strokeWidth={2.5} strokeDasharray="7 5" />
    )}
    <ellipse cx={60} cy={60} rx={35} ry={46} fill="#ffffff" stroke="currentColor" strokeWidth={2.5} />
    <g className={`gesto-pieza ${gesto === 'giro_izq' ? 'gesto-giro-izq' : gesto === 'giro_der' ? 'gesto-giro-der' : ''}`}>
      {ojo(47, gesto === 'parpadear2')}
      {ojo(73, gesto === 'parpadear2')}
      <path d="M60 55 L56 69 L63 69" {...linea} strokeWidth={2.5} />
      {gesto === 'sonreir' ? (
        <>
          <path className="gesto-serio" d="M48 82 L72 82" {...linea} />
          <path className="gesto-sonrisa" d="M43 77 Q60 98 77 77" {...linea} strokeWidth={3.5} />
        </>
      ) : gesto === 'abrir_boca' ? (
        <ellipse className="gesto-pieza gesto-boca" cx={60} cy={84} rx={12} ry={13} fill="currentColor" />
      ) : (
        <path d="M48 82 L72 82" {...linea} />
      )}
    </g>
    {gesto === 'giro_izq' && <path d="M19 60 L4 60 M11 52 L3 60 L11 68" {...linea} strokeWidth={4} className="stroke-brand-600" />}
    {gesto === 'giro_der' && <path d="M101 60 L116 60 M109 52 L117 60 L109 68" {...linea} strokeWidth={4} className="stroke-brand-600" />}
  </svg>
);

const TEXTO_INICIO = 'De frente, quieto, ojos bien abiertos y boca cerrada';

interface GuiaProps {
  onCerrar: () => void;
}

/** Guía que se ve antes de empezar (y cuando el trabajador toca "Ver cómo se hace"). La prueba no corre mientras tanto. */
export const GuiaGestos: React.FC<GuiaProps> = ({ onCerrar }) => (
  <div className="absolute inset-0 z-20 flex flex-col bg-white" role="dialog" aria-label="Cómo hacer la verificación">
    <div className="border-b border-slate-200 px-4 py-3">
      <h4 className="text-base font-semibold text-slate-900">Cómo hacer la verificación</h4>
      <p className="mt-0.5 text-sm text-slate-600">
        Ponga el celular a la altura de los ojos. Se le pedirán 3 gestos: hágalos apenas aparezcan y vuelva a mirar de frente.
      </p>
    </div>
    <ul className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3">
      {(['inicio', ...TODOS_LOS_RETOS] as Gesto[]).map((g) => (
        <li key={g} className="flex flex-col items-center border border-slate-200 p-2 text-center">
          <CaraGesto gesto={g} className="h-16 w-16" />
          <span className="mt-1 text-sm leading-tight text-slate-800">{g === 'inicio' ? TEXTO_INICIO : TEXTO_RETO[g]}</span>
        </li>
      ))}
    </ul>
    <div className="border-t border-slate-200 p-3">
      <button type="button" onClick={onCerrar} className="btn-primary w-full py-3 text-base">
        Entendido, comenzar
      </button>
    </div>
  </div>
);
