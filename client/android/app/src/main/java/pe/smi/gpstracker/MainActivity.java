package pe.smi.gpstracker;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TrackerPlugin.class); // rastreo en segundo plano (debe registrarse antes de super.onCreate)
        super.onCreate(savedInstanceState);
        recogerAlerta(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        recogerAlerta(intent);
    }

    // El trabajador tocó la notificación de una alerta del supervisor: la app web la marcará como leída
    private void recogerAlerta(Intent intent) {
        if (intent == null) return;
        int id = intent.getIntExtra(AlertNotifier.EXTRA_ID, 0);
        if (id == 0) return;
        TrackerStore.get(this).guardarAlertaAbierta(id, intent.getStringExtra(AlertNotifier.EXTRA_MENSAJE));
        intent.removeExtra(AlertNotifier.EXTRA_ID);
    }
}
