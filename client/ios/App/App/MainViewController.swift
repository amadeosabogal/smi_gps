import Capacitor

/// Pantalla principal de la app: la web de Capacitor más el plugin de rastreo propio.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TrackerPlugin())
    }
}
