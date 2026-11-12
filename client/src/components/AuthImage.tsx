import React, { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

// Imagen protegida: la foto se pide al servidor con la sesión del administrador (un <img src> normal no
// puede enviar el token) y solo cuando entra en pantalla, para no descargar cientos de fotos de golpe.
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface AuthImageProps {
  /** Ruta de la foto en el API, p. ej. /photos/attendance/12/in */
  path: string;
  alt?: string;
  className?: string;
  /** Cargar de inmediato sin esperar a que sea visible (visores/ventanas emergentes) */
  eager?: boolean;
}

export const AuthImage: React.FC<AuthImageProps> = ({ path, alt = '', className, eager = false }) => {
  const ref = useRef<HTMLImageElement | null>(null);
  const [visible, setVisible] = useState<boolean>(eager);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);

  // Cargar solo cuando la imagen entra (o está por entrar) en pantalla
  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '150px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setFailed(false);
    api
      .fetchPhoto(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, path]);

  return (
    <img
      ref={ref}
      src={src || TRANSPARENT_PIXEL}
      alt={failed ? 'Foto no disponible' : alt}
      className={`${className ?? ''} ${src ? '' : 'bg-slate-200 animate-pulse'}`}
    />
  );
};
