import UIKit
import CoreLocation

/// Captura la ubicación durante el turno, con la pantalla apagada o la app en segundo plano (equivale a
/// TrackerService.java). Todos sus métodos se llaman desde el hilo principal.
///
/// Diferencia con Android: si el trabajador cierra la app deslizándola, la captura continua se detiene. Con el
/// permiso "Siempre", iOS puede reabrirla en segundo plano al detectar un desplazamiento grande.
final class TrackerService: NSObject, CLLocationManagerDelegate {
    static let shared = TrackerService()

    private let manager = CLLocationManager()
    private let store = TrackerStore.shared
    private var capturing = false
    private var startedAt = Date()
    private var lastAccepted: Date?
    private var watchTimer: Timer?
    private var pendingPermission: (() -> Void)?
    private var statusBeforeRequest: CLAuthorizationStatus = .notDetermined

    private override init() {
        super.init()
        manager.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - Permisos

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }
    var isAuthorized: Bool { authorization == .authorizedWhenInUse || authorization == .authorizedAlways }
    var isPrecise: Bool { isAuthorized && manager.accuracyAuthorization == .fullAccuracy }
    var isAlways: Bool { authorization == .authorizedAlways }
    var isRunning: Bool { capturing && isAuthorized }

    /// Pide "al usar la app" o "siempre" y avisa cuando el trabajador responde (o si iOS no muestra nada).
    func requestPermission(always: Bool, completion: @escaping () -> Void) {
        finishPermissionRequest()
        pendingPermission = completion
        statusBeforeRequest = authorization
        if always {
            manager.requestAlwaysAuthorization()
        } else {
            manager.requestWhenInUseAuthorization()
        }
        // iOS pregunta una sola vez. Si no apareció ningún cuadro, la app sigue activa: se responde igual
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            if UIApplication.shared.applicationState == .active { self?.finishPermissionRequest() }
        }
    }

    private func finishPermissionRequest() {
        let completion = pendingPermission
        pendingPermission = nil
        completion?()
    }

    @objc private func appBecameActive() {
        finishPermissionRequest()
        TrackerNotifier.clearAppClosed()
        if store.isActive {
            if !capturing { start() }
            checkLocationState()
            TrackerUploader.shared.flush()
        }
    }

    // MARK: - Rastreo

    /// Al abrirse la app (también cuando iOS la reabre solo): si había un turno activo, sigue registrando.
    func resumeIfActive() {
        if store.isActive { start() }
    }

    func start() {
        guard isAuthorized else {
            store.lastError = "Falta el permiso de ubicación"
            checkLocationState()
            return
        }
        if !capturing {
            startedAt = Date()
            lastAccepted = nil
        }
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .other
        manager.pausesLocationUpdatesAutomatically = false // quieto también debe seguir registrando
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        manager.startUpdatingLocation()
        manager.startMonitoringSignificantLocationChanges() // permite que iOS reabra la app
        capturing = true

        if watchTimer == nil {
            watchTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
                self?.checkLocationState()
            }
        }
        checkLocationState()
        TrackerUploader.shared.flush() // vacía lo que haya quedado pendiente de antes
    }

    func stop() {
        capturing = false
        watchTimer?.invalidate()
        watchTimer = nil
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
        TrackerNotifier.cancelLocationOff()
    }

    func handle(_ result: TrackerUploader.Result) {
        if result.shiftEnded {
            // El servidor cerró el turno (p. ej. salida forzada) o es de otro dispositivo
            stop()
            TrackerNotifier.shiftEnded(reason: store.lastError)
        } else if result.tokenJustExpired {
            TrackerNotifier.tokenExpired()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard capturing, store.isActive else { return }
        let interval = Double(store.intervalMs) / 1000
        var added = false

        for location in locations {
            guard location.horizontalAccuracy >= 0 else { continue }
            // La primera lectura suele ser una posición guardada y vieja: no sirve
            guard location.timestamp > startedAt.addingTimeInterval(-10) else { continue }
            // iOS entrega varias por segundo: se guarda una por intervalo
            if let last = lastAccepted, location.timestamp.timeIntervalSince(last) < interval - 0.5 { continue }
            lastAccepted = location.timestamp

            let level = UIDevice.current.batteryLevel
            let state = UIDevice.current.batteryState
            store.add(TrackerPoint(
                latitud: location.coordinate.latitude,
                longitud: location.coordinate.longitude,
                precision: location.horizontalAccuracy,
                velocidad: location.speed >= 0 ? location.speed : nil,
                rumbo: location.course >= 0 ? location.course : nil,
                capturadoEn: location.timestamp.milliseconds,
                simulada: location.sourceInformation?.isSimulatedBySoftware ?? false,
                bateria: level >= 0 ? Int((level * 100).rounded()) : nil,
                cargando: state == .unknown ? nil : (state == .charging || state == .full)
            ))
            added = true
        }
        if added { TrackerUploader.shared.flush() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied { checkLocationState() }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if authorization != statusBeforeRequest { finishPermissionRequest() }
        guard store.isActive else { return }
        if isAuthorized && !capturing { start() } else { checkLocationState() }
    }

    // MARK: - Ubicación apagada por el trabajador

    /// Detecta si se apagó la ubicación del teléfono o se quitó el permiso durante el turno.
    private func checkLocationState() {
        DispatchQueue.global(qos: .utility).async {
            let enabled = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async { self.apply(locationEnabled: enabled) }
        }
    }

    private func apply(locationEnabled: Bool) {
        guard store.isActive else { return }
        let off = !locationEnabled || authorization == .denied || authorization == .restricted
        let since = store.gpsOffSince
        let now = Date().milliseconds

        if off && since == 0 {
            store.gpsOffSince = now
            store.addEvent(tipo: "apagado", t: now, desde: nil)
            TrackerNotifier.locationOff()
            TrackerUploader.shared.flush() // el aviso al supervisor sale de inmediato si hay internet
        } else if !off && since > 0 {
            store.gpsOffSince = 0
            store.addEvent(tipo: "encendido", t: now, desde: since)
            TrackerNotifier.cancelLocationOff()
            if capturing { manager.startUpdatingLocation() }
            TrackerUploader.shared.flush()
        }
    }
}
