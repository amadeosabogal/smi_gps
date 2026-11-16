package pe.smi.gpstracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/** Notificación de una alerta del supervisor: suena y vibra aunque la pantalla esté apagada. */
final class AlertNotifier {
    static final String EXTRA_ID = "alertaId";
    static final String EXTRA_MENSAJE = "alertaMensaje";
    private static final String CHANNEL_ID = "smi_alertas";

    private AlertNotifier() {}

    /** Aviso simple (sin acción) con el mismo canal de alta importancia: p. ej. "su turno terminó". */
    static void avisar(Context ctx, String titulo, String texto) {
        asegurarCanal(ctx);
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle(titulo)
                .setContentText(texto)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(texto))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .build();
        try {
            ((NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE)).notify(9001, n);
        } catch (SecurityException ignore) {
            // sin permiso de notificaciones
        }
    }

    private static void asegurarCanal(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel canal = new NotificationChannel(CHANNEL_ID, "Alertas del supervisor", NotificationManager.IMPORTANCE_HIGH);
            canal.setDescription("Avisos urgentes del supervisor durante su turno");
            canal.enableVibration(true);
            canal.setVibrationPattern(new long[]{0, 300, 150, 300, 150, 600});
            canal.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(canal);
        }
    }

    static void mostrar(Context ctx, int alertaId, String mensaje) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel canal = new NotificationChannel(CHANNEL_ID, "Alertas del supervisor", NotificationManager.IMPORTANCE_HIGH);
            canal.setDescription("Avisos urgentes del supervisor durante su turno");
            canal.enableVibration(true);
            canal.setVibrationPattern(new long[]{0, 300, 150, 300, 150, 600});
            canal.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(canal);
        }

        Intent abrir = new Intent(ctx, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_ID, alertaId)
                .putExtra(EXTRA_MENSAJE, mensaje);
        PendingIntent pi = PendingIntent.getActivity(ctx, alertaId, abrir, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setContentTitle("Alerta de SMI")
                .setContentText(mensaje)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(mensaje))
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        try {
            nm.notify(10_000 + alertaId, n);
        } catch (SecurityException ignore) {
            // sin permiso de notificaciones: el trabajador la verá al abrir la app
        }
    }
}
