package pe.smi.gpstracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Si el celular se reinicia (o la app se actualiza) en medio de un turno, retoma el rastreo solo.
 * El servicio revisa de nuevo con el servidor si el turno sigue activo al enviar el primer lote.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String accion = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(accion) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(accion)) return;
        try {
            if (TrackerStore.get(context).isActive()) TrackerService.iniciar(context);
        } catch (Exception e) {
            // Android puede negar iniciar un servicio en primer plano desde segundo plano; se reintenta al abrir la app
            TrackerStore.get(context).setLastError("No se pudo retomar el rastreo tras el reinicio");
        }
    }
}
