import * as faceapi from '@vladmandic/face-api';

class FaceRecognitionService {
  private modelsLoaded = false;
  private loadPromise: Promise<boolean> | null = null;

  // Carga asíncrona de los modelos de redes neuronales desde /models con warm-up de WebGL
  public async loadModels(): Promise<boolean> {
    if (this.modelsLoaded) return true;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const MODEL_URL = '/models';
        console.log('🧠 [BIOMETRÍA] Cargando modelos de reconocimiento facial...');

        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);

        this.modelsLoaded = true;
        console.log('✅ [BIOMETRÍA] Modelos cargados en memoria.');

        // Calentar WebGL (compilar shaders de TensorFlow en segundo plano para inferencia instantánea)
        if (typeof document !== 'undefined') {
          setTimeout(async () => {
            try {
              const dummyCanvas = document.createElement('canvas');
              dummyCanvas.width = 64;
              dummyCanvas.height = 64;
              await faceapi.detectSingleFace(
                dummyCanvas,
                new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
              );
              console.log('⚡ [BIOMETRÍA] Shader WebGL precalentado para disparos rápidos.');
            } catch {
              // Si falla el warmup no interfiere con el flujo principal
            }
          }, 100);
        }

        return true;
      } catch (err) {
        console.error('❌ [BIOMETRÍA] Error al cargar modelos:', err);
        this.loadPromise = null;
        return false;
      }
    })();

    return this.loadPromise;
  }

  public areModelsLoaded(): boolean {
    return this.modelsLoaded;
  }

  // Detección ligera y ultrarrápida solo de puntos faciales para prueba de vida
  public async detectFaceLandmarks(
    input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> | null> {
    await this.loadModels();

    // inputSize menor = más cuadros por segundo; el parpadeo dura ~150 ms y no debe caer entre dos frames
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 160,
      scoreThreshold: 0.3,
    });

    const result = await faceapi
      .detectSingleFace(input, options)
      .withFaceLandmarks();

    return result || null;
  }

  // Detección completa con vector descriptor de 128 flotantes para comparación 1:1
  public async detectFullFace(
    input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
  ): Promise<faceapi.WithFaceDescriptor<faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>> | null> {
    await this.loadModels();

    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 224,
      scoreThreshold: 0.25,
    });

    const result = await faceapi
      .detectSingleFace(input, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    return result || null;
  }

  public detectFace = this.detectFullFace;

  // Cálculo de Eye Aspect Ratio (EAR) para detección de parpadeo (Prueba de vida / Liveness)
  public calculateEyeAspectRatio(landmarks: faceapi.FaceLandmarks68): { leftEAR: number; rightEAR: number; avgEAR: number } {
    const points = landmarks.positions;

    const dist = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
      return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    };

    // Ojo Izquierdo (Puntos 36 al 41)
    const p36 = points[36];
    const p37 = points[37];
    const p38 = points[38];
    const p39 = points[39];
    const p40 = points[40];
    const p41 = points[41];

    const leftEAR = (dist(p37, p41) + dist(p38, p40)) / (2.0 * dist(p36, p39));

    // Ojo Derecho (Puntos 42 al 47)
    const p42 = points[42];
    const p43 = points[43];
    const p44 = points[44];
    const p45 = points[45];
    const p46 = points[46];
    const p47 = points[47];

    const rightEAR = (dist(p43, p47) + dist(p44, p46)) / (2.0 * dist(p42, p45));
    const avgEAR = (leftEAR + rightEAR) / 2.0;

    return { leftEAR, rightEAR, avgEAR };
  }

  // Comparación 1:1 de descriptores faciales (Distancia Euclidiana)
  public compareDescriptors(
    descriptor1: Float32Array | number[],
    descriptor2: Float32Array | number[],
    threshold = 0.58
  ): { distance: number; similarity: number; isMatch: boolean } {
    const d1 = descriptor1 instanceof Float32Array ? descriptor1 : new Float32Array(descriptor1);
    const d2 = descriptor2 instanceof Float32Array ? descriptor2 : new Float32Array(descriptor2);

    const distance = faceapi.euclideanDistance(d1, d2);

    // Mapeo no lineal intuitivo:
    const similarity = Math.max(0, Math.min(100, Math.round((1 - Math.pow(distance / 1.15, 1.5)) * 100)));
    const isMatch = distance < threshold;

    return {
      distance: Number(distance.toFixed(4)),
      similarity,
      isMatch,
    };
  }
}

export const faceRecognitionService = new FaceRecognitionService();
