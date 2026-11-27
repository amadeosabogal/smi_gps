package pe.smi.gpstracker;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;

/**
 * Android cierra la aplicación cuando se le quita un permiso. Esta alarma (cada 15 min aprox., sin permisos
 * especiales) revisa el permiso aunque la app esté cerrada, avisa al trabajador y lo informa al servidor.
 */
public class PermisoReceiver extends BroadcastReceiver {
    private static final long CADA_MS = 15 * 60_000L;

    static void programar(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + CADA_MS, intento(ctx));
        } catch (Exception ignore) {
            // sin alarma, el permiso se revisa igual al abrir la aplicación
        }
    }

    static void cancelar(Context ctx) {
        try {
            ((AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE)).cancel(intento(ctx));
        } catch (Exception ignore) {}
    }

    private static PendingIntent intento(Context ctx) {
        return PendingIntent.getBroadcast(ctx, 9003, new Intent(ctx, PermisoReceiver.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Context ctx = context.getApplicationContext();
        TrackerStore store = TrackerStore.get(ctx);
        if (!store.isActive()) return; // el turno terminó: no se vuelve a programar
        programar(ctx);
        boolean cambio = VigiaPermiso.revisar(ctx);
        if (!cambio && store.primerosEventos(1).isEmpty()) return;
        PendingResult pendiente = goAsync();
        new Thread(() -> {
            try {
                TrackerUploader.vaciar(ctx);
            } finally {
                pendiente.finish();
            }
        }).start();
    }
}
