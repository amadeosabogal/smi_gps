import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Por instalación: APP_ID / APP_NAME (ver compilar-apk-demo.ps1). Sin ellos es la app de SMI.
  appId: process.env.APP_ID || 'pe.smi.gpstracker',
  appName: process.env.APP_NAME || 'SMI GPS Asistencia',
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

