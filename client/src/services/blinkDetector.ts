// Detector de parpadeo (prueba de vida) basado en Eye Aspect Ratio (EAR).
// Lógica pura, sin dependencias, para poder probarla de forma aislada.
//
// Un parpadeo válido = ojos abiertos (línea base) -> ojos cerrados -> ojos abiertos de nuevo.
// Los umbrales son relativos a la línea base del propio usuario, así funciona con
// distintos tamaños de ojo y distancias a la cámara.

export interface BlinkDetectorOptions {
  /** Frames con ojos abiertos necesarios antes de aceptar un parpadeo */
  minBaselineFrames?: number;
  /** Ventana de frames abiertos usada para estimar la línea base */
  baselineWindow?: number;
  /** El ojo se considera cerrado por debajo de baseline * closedRatio */
  closedRatio?: number;
  /** El ojo se considera reabierto por encima de baseline * reopenRatio */
  reopenRatio?: number;
  /** EAR mínimo para considerar una lectura de "ojo abierto" como válida */
  minValidOpenEAR?: number;
  /** Un cierre más largo que esto (ms) no es un parpadeo (ojos cerrados a propósito) */
  maxBlinkMs?: number;
}

export type BlinkPhase = 'calibrating' | 'waiting_blink' | 'eyes_closed' | 'blinked';

export class BlinkDetector {
  private readonly minBaselineFrames: number;
  private readonly baselineWindow: number;
  private readonly closedRatio: number;
  private readonly reopenRatio: number;
  private readonly minValidOpenEAR: number;
  private readonly maxBlinkMs: number;

  private openSamples: number[] = [];
  private closedSince: number | null = null;
  private done = false;

  constructor(options: BlinkDetectorOptions = {}) {
    this.minBaselineFrames = options.minBaselineFrames ?? 3;
    this.baselineWindow = options.baselineWindow ?? 20;
    this.closedRatio = options.closedRatio ?? 0.82;
    this.reopenRatio = options.reopenRatio ?? 0.9;
    this.minValidOpenEAR = options.minValidOpenEAR ?? 0.12;
    this.maxBlinkMs = options.maxBlinkMs ?? 1500;
  }

  /** Reinicia todo el estado (usar cuando se pierde el rostro o se reintenta). */
  public reset(): void {
    this.openSamples = [];
    this.closedSince = null;
    this.done = false;
  }

  /** Línea base = percentil 75 de las lecturas abiertas (robusto ante picos de ruido). */
  public get baseline(): number {
    if (!this.openSamples.length) return 0;
    const sorted = [...this.openSamples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  }

  /** Umbral actual por debajo del cual el ojo se considera cerrado (para depuración). */
  public get closedThreshold(): number {
    return this.baseline * this.closedRatio;
  }

  public get blinked(): boolean {
    return this.done;
  }

  /**
   * Procesa una lectura de EAR promedio de ambos ojos.
   * @param ear  Eye Aspect Ratio actual
   * @param now  Marca de tiempo en ms (inyectable para pruebas)
   */
  public update(ear: number, now: number = Date.now()): BlinkPhase {
    if (this.done) return 'blinked';
    if (!Number.isFinite(ear)) return this.phase();

    const base = this.baseline;
    const closedThreshold = base * this.closedRatio;
    const reopenThreshold = base * this.reopenRatio;
    const calibrated = this.openSamples.length >= this.minBaselineFrames;

    // Ojos cerrados (solo cuando ya hay línea base fiable)
    if (calibrated && ear < closedThreshold) {
      if (this.closedSince === null) this.closedSince = now;
      return 'eyes_closed';
    }

    // Estaba cerrado y ahora reabrió
    if (this.closedSince !== null) {
      const closedFor = now - this.closedSince;
      this.closedSince = null;
      if (ear >= reopenThreshold && closedFor <= this.maxBlinkMs) {
        this.done = true;
        return 'blinked';
      }
      // Cierre demasiado largo o reapertura parcial: no cuenta como parpadeo.
      // No se registra la muestra y se sigue esperando.
      if (ear < reopenThreshold) {
        this.closedSince = now; // sigue medio cerrado, continúa el conteo
        return 'eyes_closed';
      }
      return this.phase();
    }

    // Ojo abierto: alimentar línea base (se congela mientras el ojo está cerrado)
    if (ear >= this.minValidOpenEAR) {
      this.openSamples.push(ear);
      if (this.openSamples.length > this.baselineWindow) this.openSamples.shift();
    }
    return this.phase();
  }

  private phase(): BlinkPhase {
    if (this.done) return 'blinked';
    if (this.closedSince !== null) return 'eyes_closed';
    return this.openSamples.length >= this.minBaselineFrames ? 'waiting_blink' : 'calibrating';
  }
}
