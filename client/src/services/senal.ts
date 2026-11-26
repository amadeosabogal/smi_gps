/**
 * Segundos sin ningún punto GPS a partir de los cuales el panel considera que no hay señal.
 * La app Android agrupa sus envíos cada minuto y, con el trabajador quieto, lee el GPS una vez por minuto
 * (ver RitmoGps.java): con menos margen se marcaría "sin señal" a quien está funcionando bien.
 */
export const SIN_SENAL_SEG = 180;
