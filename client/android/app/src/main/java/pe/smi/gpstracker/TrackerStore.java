package pe.smi.gpstracker;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

/**
 * Almacenamiento local del rastreo: configuración (SharedPreferences) y cola de puntos GPS
 * pendientes de enviar (SQLite). Sobrevive a que Android cierre la app o reinicie el celular,
 * así el servicio puede continuar el turno y no se pierde ningún punto sin conexión.
 */
final class TrackerStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "smi_tracker.db";
    private static final int DB_VERSION = 3;
    /** Máximo de puntos en cola (≈ 20 h a un punto cada 15 s). Si se excede, se descartan los más viejos. */
    static final int MAX_COLA = 5000;

    private static TrackerStore instance;
    private final SharedPreferences prefs;

    static synchronized TrackerStore get(Context ctx) {
        if (instance == null) instance = new TrackerStore(ctx.getApplicationContext());
        return instance;
    }

    private TrackerStore(Context ctx) {
        super(ctx, DB_NAME, null, DB_VERSION);
        prefs = ctx.getSharedPreferences("smi_tracker", Context.MODE_PRIVATE);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE puntos (id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL NOT NULL, lng REAL NOT NULL, "
                + "acc REAL NOT NULL, vel REAL, brg REAL, t INTEGER NOT NULL, sim INTEGER NOT NULL DEFAULT 0, "
                + "bat INTEGER, chg INTEGER)");
        crearTablaEventos(db);
    }

    private static void crearTablaEventos(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, "
                + "t INTEGER NOT NULL, desde INTEGER)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // v2: porcentaje de batería y si estaba conectado al cargador en el momento de cada punto
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE puntos ADD COLUMN bat INTEGER");
            db.execSQL("ALTER TABLE puntos ADD COLUMN chg INTEGER");
        }
        // v3: avisos de "ubicación apagada / encendida" pendientes de enviar
        if (oldVersion < 3) crearTablaEventos(db);
    }

    // ---------------- Configuración ----------------

    boolean isActive() { return prefs.getBoolean("activo", false); }
    String getApiBase() { return prefs.getString("apiBase", null); }
    String getToken() { return prefs.getString("token", null); }
    long getIntervalMs() { return prefs.getLong("intervalMs", 15000L); }
    boolean isTokenInvalid() { return prefs.getBoolean("tokenInvalido", false); }
    long getLastUploadAt() { return prefs.getLong("ultimoEnvio", 0L); }
    long getLastPointAt() { return prefs.getLong("ultimoPunto", 0L); }
    String getLastError() { return prefs.getString("ultimoError", null); }

    /** Última alerta del supervisor que ya se mostró en este celular (el servidor no la repite). */
    int getUltimaAlerta() { return prefs.getInt("ultimaAlerta", 0); }
    void setUltimaAlerta(int id) { prefs.edit().putInt("ultimaAlerta", id).apply(); }

    /** El trabajador tocó la notificación de una alerta: la app web debe confirmarla como leída. */
    void guardarAlertaAbierta(int id, String mensaje) {
        prefs.edit().putInt("alertaAbiertaId", id).putString("alertaAbiertaMsg", mensaje).apply();
    }

    /** Devuelve y borra la alerta tocada: {id, mensaje} o null si no hay. */
    synchronized Object[] tomarAlertaAbierta() {
        int id = prefs.getInt("alertaAbiertaId", 0);
        if (id == 0) return null;
        String msg = prefs.getString("alertaAbiertaMsg", "");
        prefs.edit().remove("alertaAbiertaId").remove("alertaAbiertaMsg").apply();
        return new Object[]{id, msg};
    }

    void start(String apiBase, String token, long intervalMs) {
        prefs.edit()
                .putInt("ultimaAlerta", 0)
                .putBoolean("activo", true)
                .putString("apiBase", apiBase)
                .putString("token", token)
                .putLong("intervalMs", intervalMs)
                .putBoolean("tokenInvalido", false)
                .remove("ultimoError")
                .remove("gpsApagadoDesde")
                .remove("permisoQuitadoDesde")
                .apply();
    }

    void setActive(boolean activo) { prefs.edit().putBoolean("activo", activo).apply(); }

    void setToken(String token) {
        prefs.edit().putString("token", token).putBoolean("tokenInvalido", false).apply();
    }

    void setTokenInvalid(boolean invalido) { prefs.edit().putBoolean("tokenInvalido", invalido).apply(); }
    void setLastUploadAt(long t) { prefs.edit().putLong("ultimoEnvio", t).apply(); }
    void setLastPointAt(long t) { prefs.edit().putLong("ultimoPunto", t).apply(); }

    void setLastError(String error) {
        SharedPreferences.Editor ed = prefs.edit();
        if (error == null) ed.remove("ultimoError"); else ed.putString("ultimoError", error);
        ed.apply();
    }

    // ---------------- Cola de puntos ----------------

    static final class Punto {
        long id;
        double lat, lng, acc;
        Double vel, brg;
        long t;
        boolean sim;
        int bat = -1; // % de batería (0-100); -1 = no disponible
        int chg = -1; // 1 = conectado al cargador, 0 = no, -1 = no disponible
    }

    synchronized void agregar(Punto p) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues v = new ContentValues();
        v.put("lat", p.lat);
        v.put("lng", p.lng);
        v.put("acc", p.acc);
        if (p.vel != null) v.put("vel", p.vel); else v.putNull("vel");
        if (p.brg != null) v.put("brg", p.brg); else v.putNull("brg");
        v.put("t", p.t);
        v.put("sim", p.sim ? 1 : 0);
        v.put("bat", p.bat);
        v.put("chg", p.chg);
        db.insert("puntos", null, v);
        // Tope de la cola: se borran los más antiguos
        db.execSQL("DELETE FROM puntos WHERE id <= (SELECT MAX(id) FROM puntos) - " + MAX_COLA);
        setLastPointAt(p.t);
    }

    synchronized List<Punto> primeros(int limite) {
        List<Punto> lista = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, lat, lng, acc, vel, brg, t, sim, bat, chg FROM puntos ORDER BY id ASC LIMIT " + limite, null);
        try {
            while (c.moveToNext()) {
                Punto p = new Punto();
                p.id = c.getLong(0);
                p.lat = c.getDouble(1);
                p.lng = c.getDouble(2);
                p.acc = c.getDouble(3);
                p.vel = c.isNull(4) ? null : c.getDouble(4);
                p.brg = c.isNull(5) ? null : c.getDouble(5);
                p.t = c.getLong(6);
                p.sim = c.getInt(7) == 1;
                p.bat = c.isNull(8) ? -1 : c.getInt(8);
                p.chg = c.isNull(9) ? -1 : c.getInt(9);
                lista.add(p);
            }
        } finally {
            c.close();
        }
        return lista;
    }

    /** Borra los puntos con id hasta (e incluyendo) maxId; la cola se envía en orden. */
    synchronized void borrarHasta(long maxId) {
        getWritableDatabase().delete("puntos", "id <= ?", new String[]{String.valueOf(maxId)});
    }

    synchronized int pendientes() {
        Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM puntos", null);
        try {
            return c.moveToFirst() ? c.getInt(0) : 0;
        } finally {
            c.close();
        }
    }

    synchronized void vaciarCola() {
        getWritableDatabase().delete("puntos", null, null);
        getWritableDatabase().delete("eventos", null, null);
        prefs.edit().remove("gpsApagadoDesde").remove("permisoQuitadoDesde").apply();
    }

    // ---------------- Permiso "todo el tiempo" quitado durante el turno ----------------

    /** Momento (ms) en que se detectó que faltaba el permiso; 0 = está completo. */
    long getPermisoQuitadoDesde() { return prefs.getLong("permisoQuitadoDesde", 0L); }
    void setPermisoQuitadoDesde(long t) {
        if (t <= 0) prefs.edit().remove("permisoQuitadoDesde").apply();
        else prefs.edit().putLong("permisoQuitadoDesde", t).apply();
    }
    long getUltimoAvisoPermiso() { return prefs.getLong("ultimoAvisoPermiso", 0L); }
    void setUltimoAvisoPermiso(long t) { prefs.edit().putLong("ultimoAvisoPermiso", t).apply(); }

    // ---------------- Ubicación apagada / encendida ----------------

    /** Momento (ms) en que se detectó la ubicación apagada; 0 = está encendida. */
    long getGpsApagadoDesde() { return prefs.getLong("gpsApagadoDesde", 0L); }
    void setGpsApagadoDesde(long t) {
        if (t <= 0) prefs.edit().remove("gpsApagadoDesde").apply();
        else prefs.edit().putLong("gpsApagadoDesde", t).apply();
    }

    static final class Evento {
        long id;
        String tipo; // "apagado" | "encendido"
        long t;
        long desde;  // solo en "encendido": cuándo se había apagado
    }

    synchronized void agregarEvento(String tipo, long t, long desde) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues v = new ContentValues();
        v.put("tipo", tipo);
        v.put("t", t);
        if (desde > 0) v.put("desde", desde); else v.putNull("desde");
        db.insert("eventos", null, v);
        db.execSQL("DELETE FROM eventos WHERE id <= (SELECT MAX(id) FROM eventos) - 200");
    }

    synchronized List<Evento> primerosEventos(int limite) {
        List<Evento> lista = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery("SELECT id, tipo, t, desde FROM eventos ORDER BY id ASC LIMIT " + limite, null);
        try {
            while (c.moveToNext()) {
                Evento e = new Evento();
                e.id = c.getLong(0);
                e.tipo = c.getString(1);
                e.t = c.getLong(2);
                e.desde = c.isNull(3) ? 0 : c.getLong(3);
                lista.add(e);
            }
        } finally {
            c.close();
        }
        return lista;
    }

    synchronized void borrarEventosHasta(long maxId) {
        getWritableDatabase().delete("eventos", "id <= ?", new String[]{String.valueOf(maxId)});
    }

    synchronized int eventosPendientes() {
        Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM eventos", null);
        try {
            return c.moveToFirst() ? c.getInt(0) : 0;
        } finally {
            c.close();
        }
    }
}
