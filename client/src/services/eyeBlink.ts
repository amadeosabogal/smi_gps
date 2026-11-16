import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// Lectura del rostro con MediaPipe Face Landmarker (blendshapes + puntos de la cara) para la prueba de vida:
// cierre de ojos, sonrisa, apertura de la boca y giro de la cabeza.
// La identidad se sigue comparando con face-api.
// Los archivos se sirven localmente (/mediapipe/wasm y /models/face_landmarker.task), sin depender de CDN.

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/models/face_landmarker.task';

// Sentido del giro de la cabeza. Con la cámara frontal SIN espejo, al girar hacia la IZQUIERDA de la persona la nariz se
// mueve hacia el lado derecho de la imagen (el valor sube). Si en algún teléfono el reto "gire a la izquierda" exigiera
// girar a la derecha, poner esto en true. Con ?debug en la dirección se ve el valor de "giro" en tiempo real.
const INVERTIR_GIRO = false;

export interface EyeReading {
  /** 0 = ojo completamente abierto, 1 = completamente cerrado (promedio de ambos ojos) */
  closed: number;
  left: number;
  right: number;
  /** Sonrisa 0..1 (promedio de las dos comisuras) */
  smile: number;
  /** Apertura de la boca 0..1 */
  jaw: number;
  /**
   * Posición de la nariz entre los bordes de la cara en la imagen sin espejo (0.5 = de frente).
   * Sube al girar la cabeza hacia la izquierda de la persona. null si no se pudo calcular.
   */
  turn: number | null;
}

class EyeBlinkService {
  private landmarker: FaceLandmarker | null = null;
  private loadPromise: Promise<boolean> | null = null;
  private lastTimestamp = 0;

  public async load(): Promise<boolean> {
    if (this.landmarker) return true;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
        const create = (delegate: 'GPU' | 'CPU') =>
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_PATH, delegate },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true,
          });

        try {
          this.landmarker = await create('GPU');
        } catch (gpuErr) {
          console.warn('[PARPADEO] GPU no disponible, usando CPU:', gpuErr);
          this.landmarker = await create('CPU');
        }
        console.log('✅ [PARPADEO] MediaPipe Face Landmarker listo.');
        return true;
      } catch (err) {
        console.error('❌ [PARPADEO] Error al cargar MediaPipe:', err);
        this.loadPromise = null;
        return false;
      }
    })();

    return this.loadPromise;
  }

  public isReady(): boolean {
    return this.landmarker !== null;
  }

  /** Devuelve la lectura del rostro del fotograma actual, o null si no hay rostro. */
  public read(video: HTMLVideoElement): EyeReading | null {
    if (!this.landmarker) return null;

    // MediaPipe exige timestamps estrictamente crecientes
    const now = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = now;

    const result = this.landmarker.detectForVideo(video, now);
    const shapes = result.faceBlendshapes?.[0]?.categories;
    if (!shapes) return null;

    let left = 0;
    let right = 0;
    let smileL = 0;
    let smileR = 0;
    let jaw = 0;
    for (const c of shapes) {
      if (c.categoryName === 'eyeBlinkLeft') left = c.score;
      else if (c.categoryName === 'eyeBlinkRight') right = c.score;
      else if (c.categoryName === 'mouthSmileLeft') smileL = c.score;
      else if (c.categoryName === 'mouthSmileRight') smileR = c.score;
      else if (c.categoryName === 'jawOpen') jaw = c.score;
    }

    // Giro de la cabeza: posición de la punta de la nariz (punto 1) entre los bordes de la cara (puntos 234 y 454)
    let turn: number | null = null;
    const lm = result.faceLandmarks?.[0];
    if (lm && lm[1] && lm[234] && lm[454]) {
      const xl = Math.min(lm[234].x, lm[454].x);
      const xr = Math.max(lm[234].x, lm[454].x);
      if (xr - xl > 1e-4) {
        const ratio = (lm[1].x - xl) / (xr - xl);
        turn = INVERTIR_GIRO ? 1 - ratio : ratio;
      }
    }

    return { closed: (left + right) / 2, left, right, smile: (smileL + smileR) / 2, jaw, turn };
  }
}

export const eyeBlinkService = new EyeBlinkService();
