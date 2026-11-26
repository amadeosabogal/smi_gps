import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Marca de la instalación (client/.env -> VITE_BRAND_NAME). Vacía = SMI, como siempre.
  const marca = (loadEnv(mode, process.cwd(), '').VITE_BRAND_NAME || '').trim()
  return {
  plugins: [
    react(),
    {
      name: 'marca-html',
      transformIndexHtml(html: string) {
        if (!marca) return html
        return html
          .replace('<title>SMI - Control de Asistencia</title>', `<title>${marca} - Control de Asistencia</title>`)
          .replace('en Tiempo Real SMI', `en Tiempo Real ${marca}`)
      },
    },
    basicSsl(),
    VitePWA({
      // 'prompt': la actualización no se aplica sola; <UpdatePrompt /> avisa y la persona decide cuándo
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'logo-blanco.png', 'logo-azul.png'],
      workbox: {
        // El wasm de MediaPipe (~14 MB) y los modelos son demasiado grandes para el precaché inicial:
        // se cachean en la primera carga (CacheFirst) y luego funcionan sin conexión.
        globIgnores: ['mediapipe/**', 'models/**'],
        // El JS principal ya supera los 2 MiB que Workbox precachea por defecto (el build fallaba al pasarse por poco)
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Eventos push/notificationclick: las alertas llegan con la app cerrada y la pantalla apagada
        importScripts: ['push-sw.js'],
        clientsClaim: true,
        // El service worker no debe responder con la app a los enlaces que atiende el servidor: sin esto, abrir
        // /descargas/smi-gps.apk en un navegador que ya usó la web mostraba la app en vez de descargar el APK.
        navigateFallbackDenylist: [/^\/descargas\//, /^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) =>
              url.pathname.startsWith('/mediapipe/') || url.pathname.startsWith('/models/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'biometria-modelos',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: marca ? `${marca} - Control de Asistencia` : 'SMI - Control de Asistencia',
        short_name: marca ? marca.slice(0, 12) : 'SMI Asistencia',
        description: 'Registro de entrada y salida con geolocalización en estaciones de trabajo',
        theme_color: '#1c42ba',
        background_color: '#1c42ba',
        // Pantalla completa: oculta la barra superior (hora, batería) y la de navegación en Android.
        // display_override prueba 'fullscreen' primero y, si el sistema no la admite, usa 'standalone'.
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    host: true, // Listen on all addresses so mobile devices in LAN can connect
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  }
}
})
