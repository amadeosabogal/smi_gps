import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import type { PositionOptions } from '@capacitor/geolocation';

export interface CoordsData {
  latitude: number;
  longitude: number;
  accuracy: number;
  speed?: number | null;
  heading?: number | null;
  timestamp: number;
}

class GeolocationService {
  private watchId: string | number | null = null;
  private isTracking = false;
  private lastKnownCoords: CoordsData | null = null;

  public getLastKnownCoords(): CoordsData | null {
    return this.lastKnownCoords;
  }

  public setLastKnownCoords(coords: CoordsData): void {
    this.lastKnownCoords = coords;
  }

  public isNative(): boolean {
    return Capacitor.isNativePlatform();
  }

  public async checkPermissionStatus(): Promise<'granted' | 'prompt' | 'denied'> {
    if (this.isNative()) {
      try {
        const status = await Geolocation.checkPermissions();
        return status.location === 'granted'
          ? 'granted'
          : status.location === 'denied'
          ? 'denied'
          : 'prompt';
      } catch {
        return 'prompt';
      }
    }

    if ('permissions' in navigator && navigator.permissions.query) {
      try {
        const p = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
        return p.state;
      } catch {
        return 'prompt';
      }
    }

    return 'prompt';
  }

  public async requestPermissions(): Promise<boolean> {
    if (this.isNative()) {
      try {
        const status = await Geolocation.requestPermissions();
        return status.location === 'granted';
      } catch (err) {
        console.error('Error solicitando permisos en Capacitor:', err);
        return false;
      }
    }

    if (!('geolocation' in navigator)) {
      alert('Tu navegador no soporta geolocalización');
      return false;
    }

    // En navegador, llamar a getCurrentPosition dispara la solicitud nativa de permisos
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.lastKnownCoords = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed,
            heading: pos.coords.heading,
            timestamp: pos.timestamp,
          };
          resolve(true);
        },
        (err) => {
          console.warn('Permiso o GPS no concedido:', err.message);
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
      );
    });
  }

  public async getCurrentPosition(options?: { allowCached?: boolean; maxWaitMs?: number }): Promise<CoordsData> {
    const allowCached = options?.allowCached ?? true;
    const maxWaitMs = options?.maxWaitMs ?? 4000;

    // Si ya tenemos coordenadas recientes (últimos 90s) y se permite caché, devolver inmediatamente (0ms)
    if (allowCached && this.lastKnownCoords && Date.now() - this.lastKnownCoords.timestamp < 90000) {
      return this.lastKnownCoords;
    }

    if (this.isNative()) {
      await this.requestPermissions();
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: maxWaitMs,
        maximumAge: allowCached ? 60000 : 0,
      });
      const coords: CoordsData = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speed: pos.coords.speed,
        heading: pos.coords.heading,
        timestamp: pos.timestamp,
      };
      this.lastKnownCoords = coords;
      return coords;
    }

    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        if (this.lastKnownCoords) return resolve(this.lastKnownCoords);
        return reject(new Error('Tu navegador o celular no soporta geolocalización GPS'));
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords: CoordsData = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed,
            heading: pos.coords.heading,
            timestamp: pos.timestamp,
          };
          this.lastKnownCoords = coords;
          resolve(coords);
        },
        (err) => {
          // Si el sensor GPS demora o falla pero tenemos posición previa, usarla de inmediato
          if (this.lastKnownCoords) {
            console.warn('GPS móvil demoró, usando última posición conocida:', this.lastKnownCoords);
            return resolve(this.lastKnownCoords);
          }

          let msg = 'No se pudo obtener la ubicación GPS.';
          switch (err.code) {
            case err.PERMISSION_DENIED:
              msg = 'Permiso denegado. Debe autorizar el acceso a la ubicación en los ajustes de su celular o navegador.';
              break;
            case err.POSITION_UNAVAILABLE:
              msg = 'Señal GPS no disponible. Active la ubicación (GPS) en su celular.';
              break;
            case err.TIMEOUT:
              msg = 'Tiempo de espera agotado al conectar con el sensor GPS de su celular.';
              break;
          }
          reject(new Error(msg));
        },
        {
          enableHighAccuracy: true,
          timeout: maxWaitMs,
          maximumAge: allowCached ? 60000 : 5000,
        }
      );
    });
  }

  public async startTracking(
    onLocation: (coords: CoordsData) => void,
    onError?: (err: any) => void
  ): Promise<void> {
    if (this.isTracking) return;

    await this.requestPermissions();
    this.isTracking = true;

    if (this.isNative()) {
      const options: PositionOptions = {
        enableHighAccuracy: true,
        timeout: 10000,
      };

      this.watchId = await Geolocation.watchPosition(options, (position, err) => {
        if (err) {
          if (onError) onError(err);
          return;
        }
        if (position) {
          const coords: CoordsData = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            speed: position.coords.speed,
            heading: position.coords.heading,
            timestamp: position.timestamp,
          };
          this.lastKnownCoords = coords;
          onLocation(coords);
        }
      });
      console.log('📡 Rastreo GPS nativo iniciado');
      return;
    }

    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const coords: CoordsData = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed,
            heading: pos.coords.heading,
            timestamp: pos.timestamp,
          };
          this.lastKnownCoords = coords;
          onLocation(coords);
        },
        (err) => {
          console.error('Error en watchPosition:', err);
          if (onError) onError(err);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 10000,
        }
      );
      console.log('📡 Rastreo GPS Web/PWA iniciado');
    }
  }

  public async stopTracking(): Promise<void> {
    if (!this.isTracking) return;

    if (this.isNative() && typeof this.watchId === 'string') {
      await Geolocation.clearWatch({ id: this.watchId });
    } else if (typeof this.watchId === 'number') {
      navigator.geolocation.clearWatch(this.watchId);
    }

    this.watchId = null;
    this.isTracking = false;
    console.log('🛑 Rastreo GPS detenido (Salida registrada)');
  }

  public getTrackingStatus(): boolean {
    return this.isTracking;
  }
}

export const geolocationService = new GeolocationService();
