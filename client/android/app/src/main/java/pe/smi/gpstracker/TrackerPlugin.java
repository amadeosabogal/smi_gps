package pe.smi.gpstracker;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Puente entre la app web (React) y el servicio nativo de rastreo.
 * La app solo dice "empieza / termina / dame el estado"; la captura y el envío los hace el servicio.
 */
@CapacitorPlugin(
        name = "SmiTracker",
        permissions = {
                @Permission(alias = "ubicacion", strings = {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}),
                @Permission(alias = "segundoPlano", strings = {Manifest.permission.ACCESS_BACKGROUND_LOCATION}),
                @Permission(alias = "notificaciones", strings = {Manifest.permission.POST_NOTIFICATIONS})
        }
)
public class TrackerPlugin extends Plugin {

    // ---------------- Permisos ----------------

    private boolean tiene(String permiso) {
        return ContextCompat.checkSelfPermission(getContext(), permiso) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean ubicacionPrecisa() { return tiene(Manifest.permission.ACCESS_FINE_LOCATION); }

    private boolean segundoPlano() {
        return Build.VERSION.SDK_INT < 29 || tiene(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    private boolean notificaciones() {
        return Build.VERSION.SDK_INT < 33 || tiene(Manifest.permission.POST_NOTIFICATIONS);
    }

    private boolean bateriaSinRestriccion() {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            return pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private boolean ubicacionActivada() {
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            return Build.VERSION.SDK_INT >= 28 ? lm.isLocationEnabled()
                    : lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception e) {
            return true;
        }
    }

    private JSObject permisos() {
        JSObject o = new JSObject();
        o.put("ubicacionPrecisa", ubicacionPrecisa());
        o.put("ubicacionAproximada", tiene(Manifest.permission.ACCESS_COARSE_LOCATION));
        o.put("segundoPlano", segundoPlano());
        o.put("notificaciones", notificaciones());
        o.put("bateriaSinRestriccion", bateriaSinRestriccion());
        o.put("ubicacionActivada", ubicacionActivada());
        return o;
    }

    @PluginMethod
    public void permisosEstado(PluginCall call) {
        call.resolve(permisos());
    }

    /** Paso 1: ubicación precisa (y aproximada). */
    @PluginMethod
    public void pedirUbicacion(PluginCall call) {
        if (ubicacionPrecisa()) {
            call.resolve(permisos());
            return;
        }
        requestPermissionForAlias("ubicacion", call, "trasPermiso");
    }

    /** Paso 2: "Permitir todo el tiempo". En Android 11+ el sistema lleva a Ajustes para elegirlo. */
    @PluginMethod
    public void pedirSegundoPlano(PluginCall call) {
        if (segundoPlano() || !ubicacionPrecisa()) {
            call.resolve(permisos());
            return;
        }
        requestPermissionForAlias("segundoPlano", call, "trasPermiso");
    }

    /** Paso 3 (Android 13+): permitir la notificación fija del servicio. */
    @PluginMethod
    public void pedirNotificaciones(PluginCall call) {
        if (notificaciones()) {
            call.resolve(permisos());
            return;
        }
        requestPermissionForAlias("notificaciones", call, "trasPermiso");
    }

    @PermissionCallback
    private void trasPermiso(PluginCall call) {
        call.resolve(permisos());
    }

    /** Paso 4: quitar la restricción de batería (evita que el fabricante cierre el servicio). */
    @PluginMethod
    public void pedirBateriaSinRestriccion(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            abrirAjustesApp(null);
        }
        call.resolve();
    }

    /** Abre un enlace (la descarga del APK nuevo) en el navegador del teléfono. */
    @PluginMethod
    public void abrirEnlace(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Enlace inválido");
            return;
        }
        try {
            getContext().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir el enlace");
        }
    }

    @PluginMethod
    public void abrirAjustes(PluginCall call) {
        abrirAjustesApp(call);
    }

    private void abrirAjustesApp(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", getContext().getPackageName(), null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        if (call != null) call.resolve();
    }

    /** Ajustes de "inicio automático" / batería propios de Xiaomi y Samsung (si existen en ese modelo). */
    @PluginMethod
    public void abrirAjustesFabricante(PluginCall call) {
        String fab = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        String[][] candidatos;
        if (fab.contains("xiaomi") || fab.contains("redmi") || fab.contains("poco")) {
            candidatos = new String[][]{
                    {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                    {"com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"}};
        } else if (fab.contains("samsung")) {
            candidatos = new String[][]{
                    {"com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"},
                    {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"}};
        } else {
            candidatos = new String[0][];
        }
        for (String[] c : candidatos) {
            try {
                Intent i = new Intent().setComponent(new ComponentName(c[0], c[1])).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject r = new JSObject();
                r.put("abierto", true);
                call.resolve(r);
                return;
            } catch (Exception ignore) {
                // esa pantalla no existe en este modelo: se prueba la siguiente
            }
        }
        JSObject r = new JSObject();
        r.put("abierto", false);
        call.resolve(r);
    }

    // ---------------- Rastreo ----------------

    /**
     * Inicia el servicio de rastreo. Se llama al marcar entrada (o al reabrir la app con el turno activo).
     * apiBase: https://dominio ; token: token de rastreo del servidor ; intervaloMs: cada cuánto pedir GPS.
     */
    @PluginMethod
    public void iniciar(PluginCall call) {
        String apiBase = call.getString("apiBase");
        String token = call.getString("token");
        Integer intervalo = call.getInt("intervaloMs", 15000);
        if (apiBase == null || token == null || apiBase.isEmpty() || token.isEmpty()) {
            call.reject("Faltan apiBase o token");
            return;
        }
        if (!ubicacionPrecisa()) {
            call.reject("Falta el permiso de ubicación precisa", "PERMISO_UBICACION");
            return;
        }
        if (!ubicacionActivada()) {
            call.reject("La ubicación del celular está desactivada", "UBICACION_DESACTIVADA");
            return;
        }
        long ms = Math.max(5000L, Math.min(120000L, intervalo == null ? 15000L : intervalo.longValue()));
        TrackerStore.get(getContext()).start(apiBase.replaceAll("/+$", ""), token, ms);
        try {
            TrackerService.iniciar(getContext());
        } catch (Exception e) {
            call.reject("No se pudo iniciar el servicio: " + e.getMessage(), "SERVICIO");
            return;
        }
        call.resolve(estado());
    }

    /** Renueva el token (cuando el servidor lo rechazó por vencido) sin reiniciar el servicio. */
    @PluginMethod
    public void actualizarToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.isEmpty()) {
            call.reject("Falta el token");
            return;
        }
        TrackerStore.get(getContext()).setToken(token);
        new Thread(() -> TrackerUploader.vaciar(getContext())).start(); // reintenta la cola de inmediato
        call.resolve(estado());
    }

    /** Envía ahora lo pendiente. Llamar ANTES de marcar salida para no perder los últimos puntos. */
    @PluginMethod
    public void enviarPendientes(PluginCall call) {
        TrackerUploader.Resultado r = TrackerUploader.vaciar(getContext());
        JSObject o = estado();
        o.put("enviados", r.enviados);
        o.put("error", r.error);
        call.resolve(o);
    }

    /** Termina el rastreo (al marcar salida). */
    @PluginMethod
    public void detener(PluginCall call) {
        TrackerStore store = TrackerStore.get(getContext());
        store.setActive(false);
        TrackerService.detener(getContext());
        store.vaciarCola();
        call.resolve(estado());
    }

    /** Si el trabajador abrió la app tocando la notificación de una alerta, la entrega una sola vez. */
    @PluginMethod
    public void alertaAbierta(PluginCall call) {
        Object[] a = TrackerStore.get(getContext()).tomarAlertaAbierta();
        JSObject o = new JSObject();
        if (a != null) {
            o.put("id", (Integer) a[0]);
            o.put("mensaje", (String) a[1]);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void estado(PluginCall call) {
        call.resolve(estado());
    }

    private JSObject estado() {
        TrackerStore s = TrackerStore.get(getContext());
        JSObject o = new JSObject();
        o.put("activo", s.isActive());
        o.put("servicioCorriendo", TrackerService.corriendo);
        o.put("pendientes", s.pendientes());
        o.put("ultimoEnvio", s.getLastUploadAt());
        o.put("ultimoPunto", s.getLastPointAt());
        o.put("tokenInvalido", s.isTokenInvalid());
        o.put("ultimoError", s.getLastError());
        o.put("fabricante", Build.MANUFACTURER);
        o.put("modelo", Build.MODEL);
        o.put("android", Build.VERSION.SDK_INT);
        o.put("permisos", permisos());
        return o;
    }
}
