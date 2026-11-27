package pe.smi.gpstracker;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

/**
 * Detecta si durante el turno el teléfono dejó de permitir la ubicación "todo el tiempo" o la ubicación precisa
 * (por ejemplo, la cambiaron a "solo mientras se usa la app"). Avisa al trabajador y deja anotado el cambio para el
 * servidor. La revisan el servicio de rastreo y, por si Android cerró la aplicación, una alarma (PermisoReceiver).
 */
final class VigiaPermiso {
    private static final long REPETIR_AVISO_MS = 15 * 60_000L;

    private VigiaPermiso() {}

    static boolean completo(Context ctx) {
        boolean precisa = tiene(ctx, Manifest.permission.ACCESS_FINE_LOCATION);
        boolean todoElTiempo = Build.VERSION.SDK_INT < 29 || tiene(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION);
        return precisa && todoElTiempo;
    }

    private static boolean tiene(Context ctx, String permiso) {
        return ContextCompat.checkSelfPermission(ctx, permiso) == PackageManager.PERMISSION_GRANTED;
    }

    /** Compara con lo último visto. Devuelve true si anotó un cambio que hay que enviar al servidor. */
    static synchronized boolean revisar(Context ctx) {
        TrackerStore store = TrackerStore.get(ctx);
        if (!store.isActive()) return false;
        boolean completo = completo(ctx);
        long desde = store.getPermisoQuitadoDesde();
        long ahora = System.currentTimeMillis();

        if (!completo) {
            boolean nuevo = desde == 0;
            if (nuevo) {
                store.setPermisoQuitadoDesde(ahora);
                store.agregarEvento("permiso_quitado", ahora, 0);
            }
            if (nuevo || ahora - store.getUltimoAvisoPermiso() >= REPETIR_AVISO_MS) {
                store.setUltimoAvisoPermiso(ahora);
                AlertNotifier.permisoQuitado(ctx);
            }
            return nuevo;
        }
        if (desde > 0) {
            store.setPermisoQuitadoDesde(0);
            store.agregarEvento("permiso_ok", ahora, desde);
            AlertNotifier.permisoRestablecido(ctx);
            return true;
        }
        return false;
    }
}
