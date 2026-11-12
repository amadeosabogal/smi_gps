import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// Lectura de cierre de ojos con MediaPipe Face Landmarker (blendshapes eyeBlinkLeft/Right).
// Se usa solo para la prueba de vida: la identidad se sigue comparando con face-api.
// Los archivos se sirven localmente (/mediapipe/wasm y /models/face_landmarker.task), sin depender de CDN.

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/models/face_landmarker.task';

export interface EyeReading {
  /** 0 = ojo completamente abierto, 1 = completamente cerrado (promedio de ambos ojos) */
  closed: number;
  left: number;
  right: number;
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

  /** Devuelve el cierre de ojos del fotograma actual, o null si no hay rostro. */
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
    for (const c of shapes) {
      if (c.categoryName === 'eyeBlinkLeft') left = c.score;
      else if (c.categoryName === 'eyeBlinkRight') right = c.score;
    }
    return { closed: (left + right) / 2, left, right };
  }
}

export const eyeBlinkService = new EyeBlinkService();
