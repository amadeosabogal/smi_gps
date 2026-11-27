import Foundation

/// Punto GPS pendiente de enviar. Los nombres coinciden con lo que espera POST /api/location/batch.
struct TrackerPoint: Codable {
    var id: Int = 0
    var latitud: Double
    var longitud: Double
    var precision: Double
    var velocidad: Double?
    var rumbo: Double?
    var capturadoEn: Int64
    var simulada: Bool
    var bateria: Int?
    var cargando: Bool?

    var json: [String: Any] {
        var o: [String: Any] = [
            "latitud": latitud, "longitud": longitud, "precision": precision,
            "capturadoEn": capturadoEn, "simulada": simulada
        ]
        if let velocidad { o["velocidad"] = velocidad }
        if let rumbo { o["rumbo"] = rumbo }
        if let bateria { o["bateria"] = bateria }
        if let cargando { o["cargando"] = cargando }
        return o
    }
}

/// Aviso de "ubicación apagada / encendida" pendiente de enviar.
struct TrackerEvent: Codable {
    var id: Int = 0
    var tipo: String // "apagado" | "encendido"
    var t: Int64
    var desde: Int64? // solo en "encendido": cuándo se había apagado

    var json: [String: Any] {
        var o: [String: Any] = ["tipo": tipo, "t": t]
        if let desde { o["desde"] = desde }
        return o
    }
}

/// Almacenamiento local del rastreo (equivale a TrackerStore.java): configuración en UserDefaults y cola de puntos
/// en un archivo. Sobrevive a que iOS cierre la app, así no se pierde ningún punto sin conexión.
final class TrackerStore {
    static let shared = TrackerStore()

    /// Máximo de puntos en cola (≈ 20 h a un punto cada 15 s). Si se excede, se descartan los más viejos.
    private static let maxPoints = 5000
    private static let maxEvents = 200

    private struct Queue: Codable {
        var nextId = 1
        var points: [TrackerPoint] = []
        var events: [TrackerEvent] = []
    }

    private let prefs = UserDefaults.standard
    private let lock = NSRecursiveLock()
    private let fileURL: URL
    private var queue: Queue

    private init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("smi_tracker_queue.json")
        if let data = try? Data(contentsOf: fileURL), let saved = try? JSONDecoder().decode(Queue.self, from: data) {
            queue = saved
        } else {
            queue = Queue()
        }
    }

    private func synced<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(queue) else { return }
        // Se puede escribir con el teléfono bloqueado (después del primer desbloqueo tras encenderlo)
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    // MARK: - Configuración

    private enum Key {
        static let active = "smi_tracker.activo"
        static let apiBase = "smi_tracker.apiBase"
        static let token = "smi_tracker.token"
        static let interval = "smi_tracker.intervalMs"
        static let tokenInvalid = "smi_tracker.tokenInvalido"
        static let lastUpload = "smi_tracker.ultimoEnvio"
        static let lastPoint = "smi_tracker.ultimoPunto"
        static let lastError = "smi_tracker.ultimoError"
        static let lastAlert = "smi_tracker.ultimaAlerta"
        static let openedAlertId = "smi_tracker.alertaAbiertaId"
        static let openedAlertMessage = "smi_tracker.alertaAbiertaMsg"
        static let gpsOffSince = "smi_tracker.gpsApagadoDesde"
        static let permissionLostSince = "smi_tracker.permisoQuitadoDesde"
    }

    var isActive: Bool {
        get { prefs.bool(forKey: Key.active) }
        set { prefs.set(newValue, forKey: Key.active) }
    }
    var apiBase: String? { prefs.string(forKey: Key.apiBase) }
    var token: String? { prefs.string(forKey: Key.token) }
    var intervalMs: Int {
        let v = prefs.integer(forKey: Key.interval)
        return v > 0 ? v : 15_000
    }
    var isTokenInvalid: Bool {
        get { prefs.bool(forKey: Key.tokenInvalid) }
        set { prefs.set(newValue, forKey: Key.tokenInvalid) }
    }
    var lastUploadAt: Int64 {
        get { Int64(prefs.integer(forKey: Key.lastUpload)) }
        set { prefs.set(Int(newValue), forKey: Key.lastUpload) }
    }
    var lastPointAt: Int64 { Int64(prefs.integer(forKey: Key.lastPoint)) }
    var lastError: String? {
        get { prefs.string(forKey: Key.lastError) }
        set { prefs.set(newValue, forKey: Key.lastError) }
    }
    /// Última alerta del supervisor que ya se mostró en este teléfono (el servidor no la repite).
    var lastAlert: Int {
        get { prefs.integer(forKey: Key.lastAlert) }
        set { prefs.set(newValue, forKey: Key.lastAlert) }
    }
    /// Momento (ms) desde el que falta "Siempre" o la ubicación precisa; 0 = el permiso está completo.
    var permissionLostSince: Int64 {
        get { Int64(prefs.integer(forKey: Key.permissionLostSince)) }
        set { prefs.set(Int(newValue), forKey: Key.permissionLostSince) }
    }
    /// Momento (ms) en que se detectó la ubicación apagada; 0 = está encendida.
    var gpsOffSince: Int64 {
        get { Int64(prefs.integer(forKey: Key.gpsOffSince)) }
        set { prefs.set(Int(newValue), forKey: Key.gpsOffSince) }
    }

    func start(apiBase: String, token: String, intervalMs: Int) {
        prefs.set(apiBase, forKey: Key.apiBase)
        prefs.set(token, forKey: Key.token)
        prefs.set(intervalMs, forKey: Key.interval)
        prefs.removeObject(forKey: Key.tokenInvalid)
        prefs.removeObject(forKey: Key.lastError)
        prefs.removeObject(forKey: Key.lastAlert)
        prefs.removeObject(forKey: Key.gpsOffSince)
        prefs.removeObject(forKey: Key.permissionLostSince)
        isActive = true
    }

    func setToken(_ token: String) {
        prefs.set(token, forKey: Key.token)
        isTokenInvalid = false
    }

    /// El trabajador tocó la notificación de una alerta: la app web debe mostrarla y marcarla como leída.
    func saveOpenedAlert(id: Int, message: String) {
        synced {
            prefs.set(id, forKey: Key.openedAlertId)
            prefs.set(message, forKey: Key.openedAlertMessage)
        }
    }

    /// Devuelve y borra la alerta tocada, si hay.
    func takeOpenedAlert() -> (id: Int, message: String)? {
        synced {
            let id = prefs.integer(forKey: Key.openedAlertId)
            guard id != 0 else { return nil }
            let message = prefs.string(forKey: Key.openedAlertMessage) ?? ""
            prefs.removeObject(forKey: Key.openedAlertId)
            prefs.removeObject(forKey: Key.openedAlertMessage)
            return (id, message)
        }
    }

    // MARK: - Cola

    func add(_ point: TrackerPoint) {
        synced {
            var p = point
            p.id = queue.nextId
            queue.nextId += 1
            queue.points.append(p)
            if queue.points.count > Self.maxPoints {
                queue.points.removeFirst(queue.points.count - Self.maxPoints)
            }
            prefs.set(Int(p.capturadoEn), forKey: Key.lastPoint)
            save()
        }
    }

    func addEvent(tipo: String, t: Int64, desde: Int64?) {
        synced {
            queue.events.append(TrackerEvent(id: queue.nextId, tipo: tipo, t: t, desde: desde))
            queue.nextId += 1
            if queue.events.count > Self.maxEvents {
                queue.events.removeFirst(queue.events.count - Self.maxEvents)
            }
            save()
        }
    }

    var pendingCount: Int { synced { queue.points.count } }

    func firstPoints(_ limit: Int) -> [TrackerPoint] { synced { Array(queue.points.prefix(limit)) } }
    func firstEvents(_ limit: Int) -> [TrackerEvent] { synced { Array(queue.events.prefix(limit)) } }

    func removePoints(upTo id: Int) {
        synced {
            queue.points.removeAll { $0.id <= id }
            save()
        }
    }

    func removeEvents(upTo id: Int) {
        synced {
            queue.events.removeAll { $0.id <= id }
            save()
        }
    }

    func clearQueue() {
        synced {
            queue.points.removeAll()
            queue.events.removeAll()
            prefs.removeObject(forKey: Key.gpsOffSince)
            prefs.removeObject(forKey: Key.permissionLostSince)
            save()
        }
    }
}

extension Date {
    var milliseconds: Int64 { Int64(timeIntervalSince1970 * 1000) }
}
