import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    VitePWA({
      // 'prompt': la actualización no se aplica sola; <UpdatePrompt /> avisa y la persona decide cuándo
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'logo-blanco.png', 'logo-azul.png'],
      workbox: {
        // El wasm de MediaPipe (~14 MB) y los modelos son demasiado grandes para el precaché inicial:
        // se cachean en la primera carga (CacheFirst) y luego funcionan sin conexión.
        globIgnores: ['mediapipe/**', 'models/**'],
        // Eventos push/notificationclick: las alertas llegan con la app cerrada y la pantalla apagada
        importScripts: ['push-sw.js'],
        clientsClaim: true,
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
        name: 'SMI - Control de Asistencia',
        short_name: 'SMI Asistencia',
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
})
