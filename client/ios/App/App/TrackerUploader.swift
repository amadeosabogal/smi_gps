import UIKit

/// Envía la cola al servidor SIN usar la web (equivale a TrackerUploader.java): funciona con la pantalla apagada
/// o la app en segundo plano.
final class TrackerUploader {
    static let shared = TrackerUploader()

    struct Result {
        var sent = 0
        var pending = 0
        var error: String?
        var offline = false
        var shiftEnded = false
        var tokenJustExpired = false
        var tokenInvalid = false
    }

    private static let batchSize = 200
    private let queue = DispatchQueue(label: "pe.smi.tracker.upload")
    private let store = TrackerStore.shared
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 15
        c.timeoutIntervalForResource = 25
        return URLSession(configuration: c)
    }()
    private var scheduled = false // solo se toca en el hilo principal

    /// Envía lo pendiente. Los envíos van de uno en uno; `completion` se llama en el hilo principal.
    func flush(_ completion: ((Result) -> Void)? = nil) {
        DispatchQueue.main.async {
            // Si ya hay un envío esperando turno y nadie necesita la respuesta, no se acumula otro
            if completion == nil && self.scheduled { return }
            self.scheduled = true

            // Pide a iOS unos segundos para terminar el envío aunque la app pase a segundo plano
            var task = UIBackgroundTaskIdentifier.invalid
            let endTask = {
                guard task != .invalid else { return }
                UIApplication.shared.endBackgroundTask(task)
                task = .invalid
            }
            task = UIApplication.shared.beginBackgroundTask(withName: "smi.envio") { endTask() }

            self.queue.async {
                DispatchQueue.main.async { self.scheduled = false }
                let result = self.performFlush()
                DispatchQueue.main.async {
                    TrackerService.shared.handle(result)
                    completion?(result)
                    endTask()
                }
            }
        }
    }

    private func performFlush() -> Result {
        var result = Result()
        defer { result.pending = store.pendingCount }

        guard let apiBase = store.apiBase, let token = store.token else {
            result.error = "Rastreo sin configurar"
            return result
        }
        if store.isTokenInvalid {
            result.tokenInvalid = true
            result.error = "La sesión de rastreo venció; abra la aplicación"
            return result
        }

        while true {
            let points = store.firstPoints(Self.batchSize)
            guard let lastId = points.last?.id else { break }

            let body: [String: Any] = ["puntos": points.map(\.json), "ultimaAlerta": store.lastAlert]
            guard let (code, data) = post(apiBase + "/api/location/batch", token: token, body: body) else {
                result.offline = true
                result.error = "No se pudo contactar al servidor"
                store.lastError = result.error
                break
            }
            // Mientras se enviaba cambió el turno o el token: la respuesta ya no aplica
            if store.token != token { break }

            if code == 200 {
                showAlerts(data)
                store.removePoints(upTo: lastId)
                result.sent += points.count
                store.lastUploadAt = Date().milliseconds
                store.lastError = nil
            } else if code == 403, let reason = shiftEndReason(data) {
                // El turno terminó o pertenece a OTRO dispositivo: estos puntos ya no sirven
                store.clearQueue()
                store.isActive = false
                result.shiftEnded = true
                store.lastError = reason
                break
            } else if code == 401 {
                expireToken(&result)
                break
            } else if code == 400 {
                // Lote mal formado: se descarta para no bloquear la cola para siempre
                store.removePoints(upTo: lastId)
                store.lastError = "El servidor rechazó un lote (400)"
            } else {
                result.error = "Servidor respondió \(code)"
                store.lastError = result.error
                break
            }
        }

        // Los avisos de ubicación apagada se envían aunque no haya puntos (sin GPS no hay puntos)
        if result.error == nil && !result.shiftEnded && !result.tokenInvalid {
            sendEvents(apiBase: apiBase, token: token, result: &result)
        }
        return result
    }

    private func sendEvents(apiBase: String, token: String, result: inout Result) {
        while true {
            let events = store.firstEvents(20)
            guard let lastId = events.last?.id else { return }

            let body: [String: Any] = ["eventos": events.map(\.json)]
            guard let (code, data) = post(apiBase + "/api/location/gps-evento", token: token, body: body) else {
                result.offline = true // se reintenta en el próximo ciclo; los avisos siguen guardados
                return
            }
            if store.token != token { return }

            if code == 200 || code == 400 {
                store.removeEvents(upTo: lastId)
            } else if code == 403 && shiftEndReason(data) != nil {
                store.removeEvents(upTo: lastId) // de otro turno: ya no sirven
                return
            } else if code == 401 {
                expireToken(&result)
                return
            } else {
                return // error del servidor: se reintenta luego
            }
        }
    }

    private func expireToken(_ result: inout Result) {
        store.isTokenInvalid = true
        result.tokenInvalid = true
        result.tokenJustExpired = true
        result.error = "La sesión de rastreo venció; abra la aplicación"
        store.lastError = result.error
    }

    private func shiftEndReason(_ data: Data) -> String? {
        let text = String(decoding: data, as: UTF8.self)
        if text.contains("OTRO_DISPOSITIVO") { return "El turno está activo en otro dispositivo" }
        if text.contains("SIN_TURNO") { return "El turno ya no está activo" }
        return nil
    }

    /// Petición síncrona (ya estamos en la cola de envíos). nil = no hubo respuesta del servidor.
    private func post(_ address: String, token: String, body: [String: Any]) -> (Int, Data)? {
        guard let url = URL(string: address), let payload = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = payload

        let done = DispatchSemaphore(value: 0)
        var response: (Int, Data)?
        session.dataTask(with: request) { data, reply, _ in
            if let http = reply as? HTTPURLResponse { response = (http.statusCode, data ?? Data()) }
            done.signal()
        }.resume()
        done.wait()
        return response
    }

    /// El servidor responde con las alertas del supervisor que aún no se mostraron: se muestran como notificación.
    private func showAlerts(_ data: Data) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let alerts = root["alertas"] as? [[String: Any]] else { return }
        for alert in alerts {
            guard let id = alert["id"] as? Int, id > store.lastAlert else { continue }
            TrackerNotifier.supervisorAlert(id: id, message: alert["mensaje"] as? String ?? "")
            store.lastAlert = id
        }
    }
}
