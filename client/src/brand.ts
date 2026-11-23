// Marca de esta instalación. Sin configurar (VITE_BRAND_NAME vacío) se muestra SMI con su logo, como siempre.
// Con VITE_BRAND_NAME definido (en client/.env, antes de compilar) se muestra ese nombre como texto en lugar del logo.
const configurada = String(import.meta.env.VITE_BRAND_NAME ?? '').trim();

/** true = hay una marca propia y se muestra como texto */
export const marcaPropia: boolean = configurada.length > 0;
/** Nombre que se muestra en pantalla, avisos y marcas de agua */
export const marcaNombre: string = configurada || 'SMI';
