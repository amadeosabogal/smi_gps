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
    private static final int DB_VERSION = 1;
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
                + "acc REAL NOT NULL, vel REAL, brg REAL, t INTEGER NOT NULL, sim INTEGER NOT NULL DEFAULT 0)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // sin migraciones por ahora
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
        db.insert("puntos", null, v);
        // Tope de la cola: se borran los más antiguos
        db.execSQL("DELETE FROM puntos WHERE id <= (SELECT MAX(id) FROM puntos) - " + MAX_COLA);
        setLastPointAt(p.t);
    }

    synchronized List<Punto> primeros(int limite) {
        List<Punto> lista = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, lat, lng, acc, vel, brg, t, sim FROM puntos ORDER BY id ASC LIMIT " + limite, null);
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
    }
}
