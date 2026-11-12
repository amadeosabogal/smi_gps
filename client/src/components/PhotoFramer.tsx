import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';

// Editor de encuadre: permite mover (arrastrar) y acercar/alejar una foto antes de guardarla.
// Lo que se ve dentro del visor es exactamente lo que se guarda (getCropped).

export interface PhotoFramerHandle {
  /** Devuelve el encuadre actual como imagen JPEG (data URL). */
  getCropped: () => string | null;
}

interface PhotoFramerProps {
  src: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const OUTPUT_WIDTH = 960; // ancho de la foto guardada; el alto sigue la proporción del visor

export const PhotoFramer = forwardRef<PhotoFramerHandle, PhotoFramerProps>(({ src }, ref) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [off, setOff] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState<boolean>(false);

  // Cargar la imagen y reiniciar el encuadre cuando cambia la foto
  useEffect(() => {
    setNatural(null);
    setLoadError(false);
    setZoom(1);
    setOff({ x: 0, y: 0 });
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => setLoadError(true);
    img.src = src;
  }, [src]);

  // Medir el visor
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Escala actual: la foto siempre cubre todo el visor (sin bordes vacíos) y el zoom la amplía
  const base = natural && box.w && box.h ? Math.max(box.w / natural.w, box.h / natural.h) : 1;
  const scale = base * zoom;

  // Mantiene la foto cubriendo el visor al mover o ampliar
  const clamp = useCallback(
    (x: number, y: number, s: number) => {
      if (!natural) return { x: 0, y: 0 };
      const maxX = Math.max(0, (natural.w * s - box.w) / 2);
      const maxY = Math.max(0, (natural.h * s - box.h) / 2);
      return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
    },
    [natural, box.w, box.h]
  );

  const changeZoom = useCallback(
    (z: number) => {
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
      setZoom(nz);
      setOff((o) => clamp(o.x, o.y, base * nz));
    },
    [base, clamp]
  );

  // Zoom con la rueda del mouse (listener no pasivo para poder evitar el desplazamiento de la página)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      changeZoom(zoom + (e.deltaY < 0 ? 0.12 : -0.12));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, changeZoom]);

  useImperativeHandle(
    ref,
    () => ({
      getCropped: () => {
        const img = imgRef.current;
        if (!img || !natural || !box.w || !box.h) return null;
        // Región de la foto original que se ve en el visor
        const sx = natural.w / 2 - (box.w / 2 + off.x) / scale;
        const sy = natural.h / 2 - (box.h / 2 + off.y) / scale;
        const sw = box.w / scale;
        const sh = box.h / scale;
        const canvas = document.createElement('canvas');
        canvas.width = OUTPUT_WIDTH;
        canvas.height = Math.round((OUTPUT_WIDTH * box.h) / box.w);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.9);
      },
    }),
    [natural, box.w, box.h, off.x, off.y, scale]
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setOff(clamp(drag.current.ox + (e.clientX - drag.current.x), drag.current.oy + (e.clientY - drag.current.y), scale));
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div>
      <div
        ref={boxRef}
        className="relative aspect-[4/3] w-full cursor-grab touch-none select-none overflow-hidden bg-slate-900 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {natural && (
          <img
            src={src}
            alt="Foto oficial"
            draggable={false}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: natural.w * scale,
              height: natural.h * scale,
              maxWidth: 'none',
              transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`,
            }}
          />
        )}

        {loadError && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">
            No se pudo mostrar la imagen. Use un archivo JPG, PNG o WebP.
          </p>
        )}

        {/* Recuadro guía: el resto de la foto se atenúa para ubicar bien el rostro */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[78%] w-[52%] border-2 border-white/90" style={{ boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.5)' }} />
        </div>
      </div>

      <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => changeZoom(zoom - 0.25)}
            aria-label="Alejar"
            className="border border-slate-300 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100"
          >
            <Minus className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => changeZoom(Number(e.target.value))}
            aria-label="Acercar o alejar"
            className="h-2 w-full cursor-pointer accent-brand-600"
          />
          <button
            type="button"
            onClick={() => changeZoom(zoom + 0.25)}
            aria-label="Acercar"
            className="border border-slate-300 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setOff({ x: 0, y: 0 });
            }}
            className="whitespace-nowrap text-sm font-medium text-brand-700 hover:underline"
          >
            Centrar
          </button>
        </div>
        <p className="text-sm text-slate-600">
          Arrastre la foto para moverla y use el control para acercar o alejar. Deje el rostro dentro del recuadro.
        </p>
      </div>
    </div>
  );
});

PhotoFramer.displayName = 'PhotoFramer';
