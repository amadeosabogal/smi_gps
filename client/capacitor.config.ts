import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'pe.smi.gpstracker',
  appName: 'SMI GPS Asistencia',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // HTTP sin cifrar solo en desarrollo (CAP_DEV=true). En producción la app debe usar HTTPS.
    cleartext: process.env.CAP_DEV === 'true',
  },
  android: {
    // La app web se sirve desde https://localhost: para hablar con un servidor de pruebas por HTTP (emulador) hay que
    // permitir contenido mixto. Solo en desarrollo (CAP_DEV=true); en producción el servidor es HTTPS.
    allowMixedContent: process.env.CAP_DEV === 'true',
  },
  plugins: {
    Geolocation: {
      // Configuration for high accuracy and foreground/background geolocation
    },
  },
};

export default config;

