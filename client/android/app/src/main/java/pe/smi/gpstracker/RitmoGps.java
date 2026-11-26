package pe.smi.gpstracker;

/**
 * Ahorro de batería: decide si el trabajador está quieto o en movimiento. Sin dependencias de Android.
 * - En movimiento: se pide el GPS con el intervalo normal (15 s).
 * - Quieto (3 minutos sin alejarse del mismo punto): una lectura por minuto, con la misma precisión.
 * - En ambos casos los envíos al servidor se agrupan: uno por minuto como mucho.
 * Apenas una lectura muestra que se movió, se vuelve al intervalo normal.
 */
final class RitmoGps {
    static final long INTERVALO_QUIETO_MS = 60_000L;
    static final long QUIETO_TRAS_MS = 180_000L;
    static final long ENVIO_CADA_MS = 55_000L; // algo menos de un minuto: con una lectura por minuto, se envía en cada una
    static final double RADIO_QUIETO_M = 50;
    static final double PRECISION_UTIL_M = 100; // lecturas peores no dicen si se movió (el servidor tampoco las guarda)
    static final double VELOCIDAD_MOVIMIENTO = 2.0; // metros por segundo
    static final double PRECISION_PARA_VELOCIDAD_M = 30;

    private boolean quieto = false;
    private boolean hayAncla = false;
    private double anclaLat = 0;
    private double anclaLng = 0;
    private double anclaPrecision = 0;
    private long anclaDesde = 0;

    boolean estaQuieto() {
        return quieto;
    }

    /**
     * Registra una lectura del GPS (velocidad en m/s, o -1 si no se conoce).
     * Devuelve true si con ella se pasó de quieto a en movimiento, o al revés.
     */
    boolean lectura(double lat, double lng, double precision, double velocidad, long t) {
        if (precision > PRECISION_UTIL_M) return false;
        double margen = Math.max(RADIO_QUIETO_M, Math.max(precision, anclaPrecision));
        boolean rapido = velocidad > VELOCIDAD_MOVIMIENTO && precision <= PRECISION_PARA_VELOCIDAD_M;
        if (!hayAncla || rapido || metros(anclaLat, anclaLng, lat, lng) > margen) {
            boolean estabaQuieto = quieto;
            hayAncla = true;
            anclaLat = lat;
            anclaLng = lng;
            anclaPrecision = precision;
            anclaDesde = t;
            quieto = false;
            return estabaQuieto;
        }
        if (!quieto && t - anclaDesde >= QUIETO_TRAS_MS) {
            quieto = true;
            return true;
        }
        return false;
    }

    /** Distancia aproximada en metros (suficiente para decenas o cientos de metros). */
    static double metros(double lat1, double lng1, double lat2, double lng2) {
        double rad = Math.PI / 180;
        double x = (lng2 - lng1) * rad * Math.cos((lat1 + lat2) / 2 * rad);
        double y = (lat2 - lat1) * rad;
        return Math.sqrt(x * x + y * y) * 6371000;
    }
}
