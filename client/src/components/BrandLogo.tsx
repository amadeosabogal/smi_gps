import React from 'react';

// Logo de SMI. "blanco" para fondos azules/oscuros; "azul" para fondos claros.
export const BrandLogo: React.FC<{ variant?: 'blanco' | 'azul'; className?: string }> = ({
  variant = 'blanco',
  className = 'h-10 w-auto',
}) => <img src={variant === 'blanco' ? '/logo-blanco.png' : '/logo-azul.png'} alt="SMI" className={className} />;
