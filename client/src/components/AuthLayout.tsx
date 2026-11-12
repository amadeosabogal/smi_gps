import React from 'react';
import { BrandLogo } from './BrandLogo';

interface AuthLayoutProps {
  titulo: string;
  subtitulo: string;
  panelTitulo: string;
  panelTexto: string;
  children: React.ReactNode;
}

// Pantalla de ingreso: panel azul institucional con el logo y formulario sobre fondo blanco.
// En celular el panel azul se reduce a una franja con el logo.
export const AuthLayout: React.FC<AuthLayoutProps> = ({ titulo, subtitulo, panelTitulo, panelTexto, children }) => (
  <div className="flex min-h-screen flex-col bg-white md:flex-row">
    <aside className="flex flex-col justify-between bg-brand-600 px-6 pb-5 pt-[calc(env(safe-area-inset-top)_+_1.25rem)] text-white md:w-5/12 md:p-12 lg:w-1/2">
      <BrandLogo variant="blanco" className="h-12 w-auto self-start md:h-24" />
      <div className="hidden max-w-md md:block">
        <h2 className="text-3xl font-semibold leading-tight">{panelTitulo}</h2>
        <p className="mt-4 text-base leading-relaxed text-brand-100">{panelTexto}</p>
      </div>
      <p className="hidden text-sm text-brand-200 md:block">© {new Date().getFullYear()} SMI. Todos los derechos reservados.</p>
    </aside>

    <main className="flex flex-1 items-start justify-center px-6 py-8 md:items-center md:px-12 md:py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-slate-900">{titulo}</h1>
        <p className="mt-1.5 text-sm text-slate-600">{subtitulo}</p>
        <div className="mt-8">{children}</div>
      </div>
    </main>
  </div>
);
