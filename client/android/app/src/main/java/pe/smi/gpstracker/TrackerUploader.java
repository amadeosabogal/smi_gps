package pe.smi.gpstracker;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Envía la cola de puntos al servidor (POST /api/location/batch) SIN usar el WebView:
 * funciona aunque la pantalla esté apagada, la app esté cerrada o el JavaScript esté pausado.
 */
final class TrackerUploader {
    private static final int LOTE = 200;

    static final class Resultado {
        boolean sinConexion;
        boolean turnoTerminado;
        boolean tokenInvalido;
        int enviados;
        int pendientes;
        String error;
    }

    private TrackerUploader() {}

    static boolean hayRed(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true; // ante la duda se intenta igual
        }
    }

    /** Envía todo lo pendiente (de a 200 puntos). Una sola ejecución a la vez. */
    static synchronized Resultado vaciar(Context ctx) {
        TrackerStore store = TrackerStore.get(ctx);
        Resultado res = new Resultado();
        String apiBase = store.getApiBase();
        String token = store.getToken();

        if (apiBase == null || token == null) {
            res.error = "Rastreo sin configurar";
            res.pendientes = store.pendientes();
            return res;
        }
        if (store.isTokenInvalid()) {
            res.tokenInvalido = true;
            res.error = "La sesión de rastreo venció; abra la aplicación";
            res.pendientes = store.pendientes();
            return res;
        }
        if (!hayRed(ctx)) {
            res.sinConexion = true;
            res.error = "Sin conexión a internet";
            store.setLastError(res.error);
            res.pendientes = store.pendientes();
            return res;
        }

        // Mantiene la CPU despierta mientras se envía (la pantalla apagada no debe cortar el envío)
        PowerManager.WakeLock wl = null;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "smi:subida");
            wl.acquire(45_000L);
        } catch (Exception ignore) {}

        try {
            while (true) {
                List<TrackerStore.Punto> filas = store.primeros(LOTE);
                if (filas.isEmpty()) break;

                JSONArray arr = new JSONArray();
                for (TrackerStore.Punto p : filas) {
                    JSONObject o = new JSONObject();
                    o.put("latitud", p.lat);
                    o.put("longitud", p.lng);
                    o.put("precision", p.acc);
                    o.put("capturadoEn", p.t);
                    if (p.vel != null) o.put("velocidad", p.vel);
                    if (p.brg != null) o.put("rumbo", p.brg);
                    o.put("simulada", p.sim);
                    arr.put(o);
                }
                JSONObject cuerpo = new JSONObject().put("puntos", arr).put("ultimaAlerta", store.getUltimaAlerta());
                long ultimoId = filas.get(filas.size() - 1).id;

                int codigo;
                String respuesta;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(apiBase + "/api/location/batch").openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(15000);
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    c.setRequestProperty("Authorization", "Bearer " + token);
                    byte[] bytes = cuerpo.toString().getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream os = c.getOutputStream()) { os.write(bytes); }
                    codigo = c.getResponseCode();
                    InputStream is = codigo >= 400 ? c.getErrorStream() : c.getInputStream();
                    respuesta = leer(is);
                } catch (Exception e) {
                    res.sinConexion = true;
                    res.error = "No se pudo contactar al servidor";
                    store.setLastError(res.error);
                    break;
                } finally {
                    if (c != null) c.disconnect();
                }

                if (codigo == 200) {
                    mostrarAlertas(ctx, store, respuesta);
                    store.borrarHasta(ultimoId);
                    res.enviados += filas.size();
                    store.setLastUploadAt(System.currentTimeMillis());
                    store.setLastError(null);
                } else if (codigo == 403 && respuesta.contains("SIN_TURNO")) {
                    // El turno terminó (o es de otro turno): estos puntos ya no sirven
                    store.vaciarCola();
                    store.setActive(false);
                    res.turnoTerminado = true;
                    store.setLastError("El turno ya no está activo");
                    break;
                } else if (codigo == 401) {
                    store.setTokenInvalid(true);
                    res.tokenInvalido = true;
                    res.error = "La sesión de rastreo venció; abra la aplicación";
                    store.setLastError(res.error);
                    break;
                } else if (codigo == 400) {
                    // Lote mal formado: se descarta para no bloquear la cola para siempre
                    store.borrarHasta(ultimoId);
                    store.setLastError("El servidor rechazó un lote (400)");
                } else {
                    res.error = "Servidor respondió " + codigo;
                    store.setLastError(res.error);
                    break;
                }
            }
        } catch (Exception e) {
            res.error = "Error al enviar: " + e.getClass().getSimpleName();
            store.setLastError(res.error);
        } finally {
            if (wl != null && wl.isHeld()) {
                try { wl.release(); } catch (Exception ignore) {}
            }
        }
        res.pendientes = store.pendientes();
        return res;
    }

    /** El servidor responde con las alertas del supervisor que aún no se mostraron: se muestran como notificación. */
    private static void mostrarAlertas(Context ctx, TrackerStore store, String respuesta) {
        try {
            JSONArray alertas = new JSONObject(respuesta).optJSONArray("alertas");
            if (alertas == null) return;
            for (int i = 0; i < alertas.length(); i++) {
                JSONObject a = alertas.getJSONObject(i);
                int id = a.getInt("id");
                if (id <= store.getUltimaAlerta()) continue;
                AlertNotifier.mostrar(ctx, id, a.optString("mensaje", ""));
                store.setUltimaAlerta(id);
            }
        } catch (Exception ignore) {
            // una respuesta sin alertas o con otro formato no debe interrumpir el envío de ubicaciones
        }
    }

    private static String leer(InputStream is) {
        if (is == null) return "";
        try (InputStream in = is; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[2048];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0 && total < 16_384) {
                out.write(buf, 0, n);
                total += n;
            }
            return out.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }
}
