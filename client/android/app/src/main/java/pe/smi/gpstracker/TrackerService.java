package pe.smi.gpstracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.HandlerThread;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Servicio en primer plano que captura la ubicación durante el turno, con la pantalla apagada
 * o la app cerrada, y la envía al servidor por sí mismo (sin depender del WebView).
 *
 * - START_STICKY: si Android lo cierra por memoria, lo vuelve a crear.
 * - Al salir de la app (deslizarla de "recientes") sigue funcionando: no depende de la actividad.
 * - Guarda cada punto en una cola local antes de enviarlo: sin internet no se pierde nada.
 */
public class TrackerService extends Service {
    static final String ACTION_START = "pe.smi.gpstracker.TRACKER_START";
    static final String ACTION_STOP = "pe.smi.gpstracker.TRACKER_STOP";
    private static final String CHANNEL_ID = "smi_rastreo";
    private static final int NOTIF_ID = 4107;

    /** ¿El servicio está corriendo en este proceso? (para el estado que ve la app) */
    static volatile boolean corriendo = false;

    private FusedLocationProviderClient fused;
    private LocationCallback callback;
    private HandlerThread hilo;
    private final ExecutorService subidas = Executors.newSingleThreadExecutor();
    private final AtomicBoolean subiendo = new AtomicBoolean(false);
    private String textoActual = "";

    static void iniciar(Context ctx) {
        Intent i = new Intent(ctx, TrackerService.class).setAction(ACTION_START);
        ContextCompat.startForegroundService(ctx, i);
    }

    static void detener(Context ctx) {
        // stopService funciona siempre (incluso con la app en segundo plano) y onDestroy libera todo
        ctx.stopService(new Intent(ctx, TrackerService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String accion = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(accion)) {
            apagar();
            stopSelf();
            return START_NOT_STICKY;
        }

        TrackerStore store = TrackerStore.get(this);
        // Android exige llamar a startForeground pronto aunque luego nos detengamos
        textoActual = "Registrando su ubicación durante el turno";
        try {
            Notification n = notificacion(textoActual);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            // Android 12+ puede negar iniciar el servicio desde segundo plano; se deja constancia y se detiene
            store.setLastError("No se pudo iniciar el servicio: " + e.getClass().getSimpleName());
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!store.isActive()) { // reinicio automático después de terminar el turno
            apagar();
            stopSelf();
            return START_NOT_STICKY;
        }

        corriendo = true;
        pedirUbicaciones(store.getIntervalMs());
        subir(); // vacía lo que haya quedado pendiente de antes
        return START_STICKY;
    }

    private void pedirUbicaciones(long intervaloMs) {
        if (callback != null) return; // ya está pidiendo
        fused = LocationServices.getFusedLocationProviderClient(this);
        hilo = new HandlerThread("smi-ubicacion");
        hilo.start();

        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervaloMs)
                .setMinUpdateIntervalMillis(Math.min(5000L, intervaloMs))
                .setWaitForAccurateLocation(false)
                .build();

        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult resultado) {
                TrackerStore store = TrackerStore.get(TrackerService.this);
                for (Location loc : resultado.getLocations()) {
                    if (!loc.hasAccuracy()) continue;
                    TrackerStore.Punto p = new TrackerStore.Punto();
                    p.lat = loc.getLatitude();
                    p.lng = loc.getLongitude();
                    p.acc = loc.getAccuracy();
                    p.vel = loc.hasSpeed() ? (double) loc.getSpeed() : null;
                    p.brg = loc.hasBearing() ? (double) loc.getBearing() : null;
                    p.t = loc.getTime();
                    p.sim = Build.VERSION.SDK_INT >= 31 ? loc.isMock() : loc.isFromMockProvider();
                    store.agregar(p);
                }
                subir();
            }
        };

        try {
            fused.requestLocationUpdates(req, callback, hilo.getLooper());
        } catch (SecurityException e) {
            TrackerStore.get(this).setLastError("Falta el permiso de ubicación");
            actualizarNotificacion("Falta el permiso de ubicación: abra la aplicación");
        }
    }

    /** Envía la cola en un hilo aparte; si ya hay un envío en curso, no se duplica. */
    private void subir() {
        if (!subiendo.compareAndSet(false, true)) return;
        subidas.execute(() -> {
            try {
                TrackerUploader.Resultado r = TrackerUploader.vaciar(this);
                if (r.turnoTerminado) {
                    apagar();
                    stopSelf();
                    return;
                }
                if (r.tokenInvalido) {
                    actualizarNotificacion("Abra la aplicación para renovar el rastreo");
                } else if (r.pendientes > 3) {
                    actualizarNotificacion("Sin conexión: " + r.pendientes + " puntos por enviar");
                } else {
                    actualizarNotificacion("Registrando su ubicación durante el turno");
                }
            } finally {
                subiendo.set(false);
            }
        });
    }

    private void apagar() {
        corriendo = false;
        try {
            if (fused != null && callback != null) fused.removeLocationUpdates(callback);
        } catch (Exception ignore) {}
        callback = null;
        if (hilo != null) {
            hilo.quitSafely();
            hilo = null;
        }
        stopForeground(true);
    }

    // Si el usuario cierra la app desde "recientes" el servicio sigue: el turno continúa registrándose.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        corriendo = false;
        try {
            if (fused != null && callback != null) fused.removeLocationUpdates(callback);
        } catch (Exception ignore) {}
        if (hilo != null) hilo.quitSafely();
        subidas.shutdown();
        super.onDestroy();
    }

    // ---------------- Notificación ----------------

    private void actualizarNotificacion(String texto) {
        if (texto.equals(textoActual)) return;
        textoActual = texto;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, notificacion(texto));
        } catch (Exception ignore) {}
    }

    private Notification notificacion(String texto) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel canal = new NotificationChannel(CHANNEL_ID, "Rastreo del turno", NotificationManager.IMPORTANCE_LOW);
            canal.setDescription("Indica que su ubicación se registra mientras dura el turno");
            canal.setShowBadge(false);
            nm.createNotificationChannel(canal);
        }
        Intent abrir = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = abrir == null ? null
                : PendingIntent.getActivity(this, 0, abrir, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("SMI GPS · Turno activo")
                .setContentText(texto)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(pi)
                .build();
    }
}
