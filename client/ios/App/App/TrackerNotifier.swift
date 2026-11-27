import Foundation
import UserNotifications

/// Notificaciones locales del rastreo (equivale a AlertNotifier.java).
enum TrackerNotifier {
    static let alertIdKey = "alertaId"
    static let alertMessageKey = "alertaMensaje"

    private static let locationOffId = "smi.ubicacion.apagada"
    private static let locationOffRepeatId = "smi.ubicacion.apagada.repetir"

    /// Nombre corto de la marca en los avisos (Info.plist → SMIMarcaCorta).
    private static var brand: String {
        Bundle.main.object(forInfoDictionaryKey: "SMIMarcaCorta") as? String ?? "SMI"
    }

    private static var center: UNUserNotificationCenter { .current() }

    private static func show(_ identifier: String, title: String, body: String,
                             userInfo: [String: Any] = [:], trigger: UNNotificationTrigger? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = userInfo
        // Sin permiso de notificaciones iOS la descarta; el trabajador lo verá al abrir la app
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
    }

    static func supervisorAlert(id: Int, message: String) {
        show("smi.alerta.\(id)", title: "Alerta de \(brand)", body: message,
             userInfo: [alertIdKey: id, alertMessageKey: message])
    }

    /// Aviso inmediato y, mientras siga apagada, uno cada 2 minutos (iOS lo repite aunque la app esté suspendida).
    static func locationOff() {
        let body = "Su ubicación está APAGADA durante el turno. Actívela ahora. Esto queda registrado y se informa a su supervisor."
        show(locationOffId, title: "Active su ubicación", body: body)
        show(locationOffRepeatId, title: "Active su ubicación", body: body,
             trigger: UNTimeIntervalNotificationTrigger(timeInterval: 120, repeats: true))
    }

    static func cancelLocationOff() {
        let ids = [locationOffId, locationOffRepeatId]
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    private static let permissionId = "smi.permiso"

    static func permissionMissing() {
        show(permissionId, title: "Corrija el permiso de ubicación",
             body: "Su ubicación no está en «Siempre» y precisa. Abra la aplicación y corríjalo. Se informa a la oficina.")
    }

    static func cancelPermissionMissing() {
        center.removePendingNotificationRequests(withIdentifiers: [permissionId])
        center.removeDeliveredNotifications(withIdentifiers: [permissionId])
    }

    static func shiftEnded(reason: String?) {
        let otherDevice = reason?.contains("otro dispositivo") == true
        show("smi.turno", title: "\(brand) GPS",
             body: otherDevice
                ? "Su turno está activo en otro dispositivo: este teléfono dejó de registrar su ubicación."
                : "Su turno ha terminado: su ubicación ya no se registra.")
    }

    static func tokenExpired() {
        show("smi.token", title: "\(brand) GPS", body: "Abra la aplicación para renovar el rastreo.")
    }

    static func appClosed() {
        show("smi.cerrada", title: "El rastreo puede detenerse",
             body: "Cerró la aplicación durante su turno. Ábrala de nuevo para seguir registrando su ubicación.")
    }

    static func clearAppClosed() {
        center.removeDeliveredNotifications(withIdentifiers: ["smi.cerrada"])
    }
}
