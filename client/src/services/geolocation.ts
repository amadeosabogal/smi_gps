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

// El plugin nativo responde en inglés: se traduce según su código antes de mostrarlo al trabajador.
const MENSAJES_NATIVOS: Record<string, string> = {
  'OS-PLUG-GLOC-0003': 'Permiso denegado. Autorice la ubicación para esta aplicación en los Ajustes del celular.',
  'OS-PLUG-GLOC-0007': 'La ubicación del celular está desactivada. Actívela en los Ajustes.',
  'OS-PLUG-GLOC-0008': 'El uso de la ubicación está restringido en este celular. Revise los Ajustes.',
  'OS-PLUG-GLOC-0010': 'No se pudo obtener la ubicación a tiempo. Salga a un lugar abierto e intente de nuevo.',
};
const errorNativo = (err: any): Error =>
  new Error(MENSAJES_NATIVOS[err?.code] || 'No se pudo obtener la ubicación GPS. Intente de nuevo.');

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
      }).catch((err) => {
        throw errorNativo(err);
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
          // Si el sensor GPS demora o falla pero tenemos una posición MUY reciente, usarla; una vieja no sirve
          if (this.lastKnownCoords && Date.now() - this.lastKnownCoords.timestamp < 15000) {
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

  /**
   * Espera una lectura GPS FRESCA y PRECISA. Sigue escuchando al sensor hasta obtener una precisión
   * de maxAccuracy metros o mejor (o hasta agotar waitMs) y devuelve la mejor lectura que llegó.
   * Nunca reutiliza una posición guardada: en un vehículo una posición de hace un minuto está a ~1 km.
   */
  public async getPrecisePosition(options: {
    maxAccuracy: number;
    waitMs?: number;
    onProgress?: (accuracy: number) => void;
  }): Promise<{ coords: CoordsData; precise: boolean }> {
    const waitMs = options.waitMs ?? 12000;
    const toCoords = (pos: { coords: GeolocationCoordinates | { latitude: number; longitude: number; accuracy: number; speed?: number | null; heading?: number | null }; timestamp: number }): CoordsData => ({
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      speed: pos.coords.speed,
      heading: pos.coords.heading,
      timestamp: pos.timestamp,
    });

    return new Promise((resolve, reject) => {
      let best: CoordsData | null = null;
      let finished = false;
      let watchId: string | number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const stop = () => {
        if (timer) clearTimeout(timer);
        if (watchId !== null) {
          if (typeof watchId === 'string') Geolocation.clearWatch({ id: watchId }).catch(() => {});
          else navigator.geolocation.clearWatch(watchId);
          watchId = null;
        }
      };
      const finish = (precise: boolean) => {
        if (finished) return;
        finished = true;
        stop();
        if (best) {
          this.lastKnownCoords = best;
          resolve({ coords: best, precise });
        } else {
          const destino = this.isNative() ? 'a esta aplicación' : 'al navegador';
          reject(new Error(`No se pudo obtener la ubicación GPS. Active la ubicación en su celular y permita el acceso ${destino}.`));
        }
      };
      const onReading = (c: CoordsData) => {
        if (!best || c.accuracy < best.accuracy) best = c;
        options.onProgress?.(c.accuracy);
        if (c.accuracy <= options.maxAccuracy) finish(true);
      };
      const onFail = (message: string) => {
        if (!best) {
          finished = true;
          stop();
          reject(new Error(message));
        }
      };

      timer = setTimeout(() => finish(false), waitMs);

      if (this.isNative()) {
        this.requestPermissions().then(async () => {
          watchId = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: waitMs }, (pos, err) => {
            if (err) return onFail('No se pudo obtener la ubicación GPS.');
            if (pos) onReading(toCoords(pos));
          });
        });
        return;
      }

      if (!('geolocation' in navigator)) return onFail('Su navegador o celular no soporta geolocalización GPS.');
      watchId = navigator.geolocation.watchPosition(
        (pos) => onReading(toCoords(pos)),
        (err) =>
          onFail(
            err.code === err.PERMISSION_DENIED
              ? 'Permiso denegado. Debe autorizar el acceso a la ubicación en los ajustes de su celular o navegador.'
              : 'Señal GPS no disponible. Active la ubicación (GPS) en su celular.'
          ),
        { enableHighAccuracy: true, maximumAge: 0, timeout: waitMs }
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
