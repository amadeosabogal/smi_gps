import UIKit
import Capacitor
import CoreLocation
import UserNotifications

/// Puente entre la app web (React) y el rastreo nativo (equivale a TrackerPlugin.java, con los mismos métodos).
@objc(TrackerPlugin)
public class TrackerPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "TrackerPlugin"
    public let jsName = "SmiTracker"
    public let pluginMethods: [CAPPluginMethod] = [
        "permisosEstado", "pedirUbicacion", "pedirSegundoPlano", "pedirNotificaciones", "pedirBateriaSinRestriccion",
        "abrirAjustes", "abrirAjustesUbicacion", "abrirAjustesFabricante", "iniciar", "actualizarToken",
        "enviarPendientes", "detener", "estado", "alertaAbierta", "abrirEnlace"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private var service: TrackerService { TrackerService.shared }
    private var store: TrackerStore { TrackerStore.shared }

    override public func load() {
        bridge?.notificationRouter.localNotificationHandler = self
    }

    // MARK: - Notificaciones

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    public func didReceive(response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        guard let id = info[TrackerNotifier.alertIdKey] as? Int else { return }
        store.saveOpenedAlert(id: id, message: info[TrackerNotifier.alertMessageKey] as? String ?? "")
        // La app puede haberse activado antes de guardar la alerta: se le avisa para que la lea
        notifyListeners("alertaTocada", data: [:])
    }

    // MARK: - Permisos

    /// Estado de los permisos. `completion` se llama en el hilo principal.
    private func readPermissions(_ completion: @escaping ([String: Any]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let locationEnabled = CLLocationManager.locationServicesEnabled()
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                DispatchQueue.main.async {
                    let notifications = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
                    completion([
                        "ubicacionPrecisa": self.service.isPrecise,
                        "ubicacionAproximada": self.service.isAuthorized,
                        "segundoPlano": self.service.isAlways,
                        "notificaciones": notifications,
                        "bateriaSinRestriccion": true, // iOS no tiene esta restricción por aplicación
                        "ubicacionActivada": locationEnabled
                    ])
                }
            }
        }
    }

    private func resolvePermissions(_ call: CAPPluginCall) {
        readPermissions { call.resolve($0) }
    }

    private func openSettings() {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
    }

    @objc func permisosEstado(_ call: CAPPluginCall) {
        resolvePermissions(call)
    }

    /// Paso 1: ubicación precisa, "al usar la app".
    @objc func pedirUbicacion(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.service.isPrecise {
                self.resolvePermissions(call)
            } else if self.service.authorization == .notDetermined {
                self.service.requestPermission(always: false) { self.resolvePermissions(call) }
            } else {
                // Ya respondió antes (o dejó la ubicación aproximada): solo se puede cambiar en Ajustes
                self.openSettings()
                self.resolvePermissions(call)
            }
        }
    }

    /// Paso 2: permiso "Siempre".
    @objc func pedirSegundoPlano(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.service.isAlways || !self.service.isAuthorized {
                self.resolvePermissions(call)
            } else {
                self.service.requestPermission(always: true) { self.resolvePermissions(call) }
            }
        }
    }

    @objc func pedirNotificaciones(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound]) { _, _ in self.resolvePermissions(call) }
            } else {
                if settings.authorizationStatus == .denied { self.openSettings() }
                self.resolvePermissions(call)
            }
        }
    }

    @objc func pedirBateriaSinRestriccion(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func abrirAjustes(_ call: CAPPluginCall) {
        openSettings()
        call.resolve()
    }

    /// iOS no permite abrir directamente los ajustes de Localización del sistema: se abren los de la app.
    @objc func abrirAjustesUbicacion(_ call: CAPPluginCall) {
        openSettings()
        call.resolve()
    }

    @objc func abrirAjustesFabricante(_ call: CAPPluginCall) {
        call.resolve(["abierto": false])
    }

    @objc func abrirEnlace(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), text.hasPrefix("https://") || text.hasPrefix("http://"),
              let url = URL(string: text) else {
            call.reject("Enlace inválido")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("No se pudo abrir el enlace") }
            }
        }
    }

    // MARK: - Rastreo

    private func resolveState(_ call: CAPPluginCall, extra: [String: Any] = [:]) {
        readPermissions { permissions in
            var state: [String: Any] = [
                "activo": self.store.isActive,
                "servicioCorriendo": self.service.isRunning,
                "pendientes": self.store.pendingCount,
                "ultimoEnvio": self.store.lastUploadAt,
                "ultimoPunto": self.store.lastPointAt,
                "tokenInvalido": self.store.isTokenInvalid,
                "ultimoError": self.store.lastError ?? NSNull(),
                "fabricante": "Apple",
                "modelo": UIDevice.current.model,
                "android": 0,
                "permisos": permissions
            ]
            state.merge(extra) { _, new in new }
            call.resolve(state)
        }
    }

    /// Se llama al marcar entrada (o al reabrir la app con el turno activo).
    @objc func iniciar(_ call: CAPPluginCall) {
        guard var apiBase = call.getString("apiBase"), let token = call.getString("token"),
              !apiBase.isEmpty, !token.isEmpty else {
            call.reject("Faltan apiBase o token")
            return
        }
        while apiBase.hasSuffix("/") { apiBase.removeLast() }
        let interval = max(5_000, min(120_000, call.getInt("intervaloMs") ?? 15_000))

        DispatchQueue.global(qos: .userInitiated).async {
            let locationEnabled = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async {
                if !locationEnabled {
                    call.reject("La ubicación del teléfono está desactivada", "UBICACION_DESACTIVADA")
                } else if !self.service.isPrecise {
                    call.reject("Falta el permiso de ubicación precisa", "PERMISO_UBICACION")
                } else {
                    self.store.start(apiBase: apiBase, token: token, intervalMs: interval)
                    self.service.start()
                    self.resolveState(call)
                }
            }
        }
    }

    /// Renueva el token (cuando el servidor lo rechazó por vencido) sin reiniciar el rastreo.
    @objc func actualizarToken(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("Falta el token")
            return
        }
        DispatchQueue.main.async {
            self.store.setToken(token)
            TrackerUploader.shared.flush()
            self.resolveState(call)
        }
    }

    /// Envía ahora lo pendiente. Se llama ANTES de marcar salida para no perder los últimos puntos.
    @objc func enviarPendientes(_ call: CAPPluginCall) {
        TrackerUploader.shared.flush { result in
            self.resolveState(call, extra: ["enviados": result.sent, "error": result.error ?? NSNull()])
        }
    }

    /// Termina el rastreo (al marcar salida).
    @objc func detener(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.store.isActive = false
            self.service.stop()
            self.store.clearQueue()
            self.resolveState(call)
        }
    }

    @objc func estado(_ call: CAPPluginCall) {
        resolveState(call)
    }

    /// Si el trabajador tocó la notificación de una alerta, la entrega una sola vez.
    @objc func alertaAbierta(_ call: CAPPluginCall) {
        if let alert = store.takeOpenedAlert() {
            call.resolve(["id": alert.id, "mensaje": alert.message])
        } else {
            call.resolve([:])
        }
    }
}
