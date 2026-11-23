import React from 'react';
import { marcaPropia, marcaNombre } from '../brand';

// Logo de la instalación. "blanco" para fondos azules/oscuros; "azul" para fondos claros.
// Si la instalación tiene marca propia (VITE_BRAND_NAME), se muestra su nombre como texto en lugar del logo de SMI.
export const BrandLogo: React.FC<{ variant?: 'blanco' | 'azul'; className?: string }> = ({
  variant = 'blanco',
  className = 'h-10 w-auto',
}) => {
  if (marcaPropia) {
    // El tamaño del logo (h-*, w-*) no aplica a un texto: se conservan solo las clases de posición
    const posicion = className.split(/\s+/).filter((c) => c && !/(^|:)(h|w)-/.test(c)).join(' ');
    return (
      <span className={`inline-block text-2xl font-extrabold leading-none tracking-tight md:text-3xl ${variant === 'blanco' ? 'text-white' : 'text-brand-700'} ${posicion}`}>
        {marcaNombre}
      </span>
    );
  }
  return <img src={variant === 'blanco' ? '/logo-blanco.png' : '/logo-azul.png'} alt="SMI" className={className} />;
};
