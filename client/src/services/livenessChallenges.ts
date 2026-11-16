// Prueba de vida con RETOS ALEATORIOS.
//
// Un parpadeo fijo se puede esquivar con un video grabado. Aquí el sistema pide una secuencia de movimientos
// DISTINTA cada vez (girar la cabeza, sonreír, abrir la boca, parpadear dos veces) y solo cuenta lo que ocurre
// DESPUÉS de pedirlo, con el rostro antes en reposo. Un video grabado no puede saber qué se va a pedir.
//
// Lógica pura (sin cámara ni DOM) para poder probarla de forma aislada con lecturas simuladas.

import { BlinkDetector } from './blinkDetector.ts';

export type TipoReto = 'giro_izq' | 'giro_der' | 'sonreir' | 'abrir_boca' | 'parpadear2';

export const TODOS_LOS_RETOS: TipoReto[] = ['giro_izq', 'giro_der', 'sonreir', 'abrir_boca', 'parpadear2'];

/** Una lectura de la cámara (MediaPipe). Los valores van de 0 a 1. */
export interface Lectura {
  /** Cierre de los ojos: 0 abiertos, 1 cerrados */
  cerrado: number;
  /** Sonrisa (promedio de las comisuras) */
  sonrisa: number;
  /** Apertura de la boca (mandíbula) */
  boca: number;
  /**
   * Posición de la nariz entre los bordes de la cara en la imagen SIN espejo: 0.5 = de frente.
   * Al girar la cabeza hacia la IZQUIERDA del usuario la nariz se mueve hacia el lado derecho de la imagen cruda
   * (en la vista tipo espejo que ve el usuario se mueve hacia su izquierda), así que el valor SUBE.
   */
  giro: number;
}

export type FaseRetos = 'calibrando' | 'reto' | 'frontal' | 'listo' | 'fallo';
export type MotivoFallo = 'tiempo' | 'sin_rostro' | 'inestable';

export interface EstadoRetos {
  fase: FaseRetos;
  /** Reto actual (0..total-1) */
  indice: number;
  total: number;
  reto: TipoReto | null;
  /** Falta que la persona vuelva a estar en reposo antes de pedirle el reto */
  esperandoReposo: boolean;
  /** Milisegundos que quedan para completar el reto actual */
  restanteMs: number;
  /** Para "parpadear dos veces": parpadeos ya detectados */
  parpadeos: number;
  motivo?: MotivoFallo;
}

export interface ConfigRetos {
  calibracionFrames: number;
  giroTolerancia0: number;
  giroDelta: number;
  sonrisaMin: number;
  sonrisaDelta: number;
  bocaMin: number;
  bocaDelta: number;
  reposoFrames: number;
  confirmarFrames: number;
  ventanaRetoMs: number;
  esperaReposoMs: number;
  sinRostroMs: number;
  frontalFrames: number;
  frontalMs: number;
  calibracionMs: number;
  parpadeosRequeridos: number;
}

export const CONFIG_RETOS: ConfigRetos = {
  calibracionFrames: 8,
  giroTolerancia0: 0.12, // al empezar debe mirar de frente
  giroDelta: 0.12, // desplazamiento de la nariz que cuenta como giro (~15°)
  sonrisaMin: 0.45,
  sonrisaDelta: 0.3,
  bocaMin: 0.35,
  bocaDelta: 0.25,
  reposoFrames: 4, // fotogramas seguidos en reposo antes de pedir cada reto
  confirmarFrames: 3, // fotogramas seguidos con el gesto para darlo por hecho
  ventanaRetoMs: 4500, // tiempo para hacer lo pedido (un video en bucle tiene pocas probabilidades de coincidir)
  esperaReposoMs: 6000,
  sinRostroMs: 2500,
  frontalFrames: 8,
  frontalMs: 6000,
  calibracionMs: 15000,
  parpadeosRequeridos: 2,
};

/** Baraja los 5 retos y toma n distintos (por defecto 3: 60 secuencias posibles). */
export function generarSecuencia(n = 3, aleatorio: () => number = Math.random): TipoReto[] {
  const copia = [...TODOS_LOS_RETOS];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, Math.max(1, Math.min(n, copia.length)));
}

const mediana = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export class EjecutorRetos {
  private readonly cfg: ConfigRetos;
  private secuencia: TipoReto[];

  private fase: FaseRetos = 'calibrando';
  private indice = 0;
  private motivo: MotivoFallo | undefined;

  // línea base del rostro en reposo (de la propia persona)
  private base = { giro: 0.5, sonrisa: 0, boca: 0 };
  private muestras: Lectura[] = [];

  private esperandoReposo = true;
  private reposoSeguidos = 0;
  private confirmados = 0;
  private inicioFase = 0;
  private inicioReto = 0;
  private inicioEspera = 0;
  private ultimaCara = 0;
  private frontalSeguidos = 0;
  private parpadeos = 0;
  private detectorParpadeo: BlinkDetector;

  constructor(secuencia: TipoReto[], cfg: ConfigRetos = CONFIG_RETOS) {
    this.cfg = cfg;
    this.secuencia = secuencia;
    this.detectorParpadeo = this.nuevoDetector();
  }

  private nuevoDetector(): BlinkDetector {
    // se alimenta con "apertura" = 1 - cierre (≈0.9 abierto, <0.5 cerrado)
    return new BlinkDetector({ closedRatio: 0.7, reopenRatio: 0.85, minValidOpenEAR: 0.5 });
  }

  public get retoActual(): TipoReto | null {
    return this.fase === 'reto' ? this.secuencia[this.indice] : null;
  }

  /** Empieza de nuevo con otra secuencia. */
  public reiniciar(secuencia: TipoReto[]): void {
    this.secuencia = secuencia;
    this.fase = 'calibrando';
    this.indice = 0;
    this.motivo = undefined;
    this.muestras = [];
    this.esperandoReposo = true;
    this.reposoSeguidos = 0;
    this.confirmados = 0;
    this.inicioFase = 0;
    this.inicioReto = 0;
    this.inicioEspera = 0;
    this.ultimaCara = 0;
    this.frontalSeguidos = 0;
    this.parpadeos = 0;
    this.detectorParpadeo = this.nuevoDetector();
  }

  private enReposo(l: Lectura): boolean {
    return (
      Math.abs(l.giro - this.base.giro) <= 0.07 &&
      l.sonrisa <= Math.min(0.3, this.base.sonrisa + 0.12) &&
      l.boca <= this.base.boca + 0.1 &&
      l.cerrado < 0.35
    );
  }

  private hayGesto(tipo: TipoReto, l: Lectura): boolean {
    const c = this.cfg;
    switch (tipo) {
      case 'giro_izq':
        return l.giro - this.base.giro >= c.giroDelta;
      case 'giro_der':
        return this.base.giro - l.giro >= c.giroDelta;
      case 'sonreir':
        return l.sonrisa >= Math.max(c.sonrisaMin, this.base.sonrisa + c.sonrisaDelta);
      case 'abrir_boca':
        return l.boca >= Math.max(c.bocaMin, this.base.boca + c.bocaDelta);
      default:
        return false;
    }
  }

  private fallar(motivo: MotivoFallo): void {
    this.fase = 'fallo';
    this.motivo = motivo;
  }

  private estado(ahora: number): EstadoRetos {
    let restante = 0;
    if (this.fase === 'reto' && !this.esperandoReposo) restante = Math.max(0, this.cfg.ventanaRetoMs - (ahora - this.inicioReto));
    return {
      fase: this.fase,
      indice: this.indice,
      total: this.secuencia.length,
      reto: this.retoActual,
      esperandoReposo: this.fase === 'reto' && this.esperandoReposo,
      restanteMs: restante,
      parpadeos: this.parpadeos,
      motivo: this.motivo,
    };
  }

  /**
   * Procesa una lectura (o null si no se ve ningún rostro) en el instante `ahora` (ms).
   * Devuelve el estado actual para mostrárselo a la persona.
   */
  public actualizar(l: Lectura | null, ahora: number): EstadoRetos {
    if (this.fase === 'listo' || this.fase === 'fallo') return this.estado(ahora);
    if (!this.inicioFase) {
      this.inicioFase = ahora;
      this.ultimaCara = ahora;
    }

    // Sin rostro: se pierde el progreso del gesto en curso y, si dura, la prueba falla
    if (!l) {
      this.confirmados = 0;
      this.reposoSeguidos = 0;
      this.frontalSeguidos = 0;
      this.muestras = [];
      if (ahora - this.ultimaCara > this.cfg.sinRostroMs) this.fallar('sin_rostro');
      return this.estado(ahora);
    }
    this.ultimaCara = ahora;

    switch (this.fase) {
      case 'calibrando':
        return this.calibrar(l, ahora);
      case 'reto':
        return this.hacerReto(l, ahora);
      case 'frontal':
        return this.mirarDeFrente(l, ahora);
      default:
        return this.estado(ahora);
    }
  }

  private calibrar(l: Lectura, ahora: number): EstadoRetos {
    const c = this.cfg;
    const apto = Math.abs(l.giro - 0.5) <= c.giroTolerancia0 && l.sonrisa < 0.25 && l.boca < 0.2 && l.cerrado < 0.4;
    this.muestras = apto ? [...this.muestras, l].slice(-c.calibracionFrames) : [];
    if (this.muestras.length >= c.calibracionFrames) {
      this.base = {
        giro: mediana(this.muestras.map((m) => m.giro)),
        sonrisa: mediana(this.muestras.map((m) => m.sonrisa)),
        boca: mediana(this.muestras.map((m) => m.boca)),
      };
      this.fase = 'reto';
      this.indice = 0;
      this.iniciarReto(ahora);
    } else if (ahora - this.inicioFase > c.calibracionMs) {
      this.fallar('inestable');
    }
    return this.estado(ahora);
  }

  private iniciarReto(ahora: number): void {
    this.esperandoReposo = true;
    this.reposoSeguidos = 0;
    this.confirmados = 0;
    this.inicioEspera = ahora;
    this.parpadeos = 0;
    this.detectorParpadeo = this.nuevoDetector();
  }

  private hacerReto(l: Lectura, ahora: number): EstadoRetos {
    const c = this.cfg;
    const tipo = this.secuencia[this.indice];

    // 1) Antes de pedir el reto, el rostro debe estar en reposo (así un gesto anterior no cuenta como respuesta)
    if (this.esperandoReposo) {
      this.reposoSeguidos = this.enReposo(l) ? this.reposoSeguidos + 1 : 0;
      if (this.reposoSeguidos >= c.reposoFrames) {
        this.esperandoReposo = false;
        this.inicioReto = ahora;
        this.confirmados = 0;
      } else if (ahora - this.inicioEspera > c.esperaReposoMs) {
        this.fallar('inestable');
      }
      return this.estado(ahora);
    }

    // 2) Ventana para hacer lo pedido
    if (ahora - this.inicioReto > c.ventanaRetoMs) {
      this.fallar('tiempo');
      return this.estado(ahora);
    }

    let hecho = false;
    if (tipo === 'parpadear2') {
      if (this.detectorParpadeo.update(1 - l.cerrado, ahora) === 'blinked') {
        this.parpadeos += 1;
        this.detectorParpadeo = this.nuevoDetector();
      }
      hecho = this.parpadeos >= c.parpadeosRequeridos;
    } else {
      this.confirmados = this.hayGesto(tipo, l) ? this.confirmados + 1 : 0;
      hecho = this.confirmados >= c.confirmarFrames;
    }

    if (hecho) {
      this.indice += 1;
      if (this.indice >= this.secuencia.length) {
        this.fase = 'frontal';
        this.frontalSeguidos = 0;
        this.inicioFase = ahora;
      } else {
        this.iniciarReto(ahora);
      }
    }
    return this.estado(ahora);
  }

  // Al terminar, se pide mirar de frente y en reposo: esa es la imagen que se compara con el rostro registrado
  private mirarDeFrente(l: Lectura, ahora: number): EstadoRetos {
    this.frontalSeguidos = this.enReposo(l) ? this.frontalSeguidos + 1 : 0;
    if (this.frontalSeguidos >= this.cfg.frontalFrames) {
      this.fase = 'listo';
    } else if (ahora - this.inicioFase > this.cfg.frontalMs) {
      this.fallar('inestable');
    }
    return this.estado(ahora);
  }
}

/** Distancia euclídea entre dos descriptores faciales (para comprobar que es la misma cara al inicio y al final). */
export function distanciaDescriptores(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/** Si la misma cara no se mantiene entre el inicio y el final de la prueba, se rechaza (anti-cambio de rostro). */
export const DISTANCIA_MAX_CONTINUIDAD = 0.5;

export const TEXTO_RETO: Record<TipoReto, string> = {
  giro_izq: 'Gire la cabeza hacia su izquierda',
  giro_der: 'Gire la cabeza hacia su derecha',
  sonreir: 'Sonría',
  abrir_boca: 'Abra la boca',
  parpadear2: 'Parpadee dos veces',
};
