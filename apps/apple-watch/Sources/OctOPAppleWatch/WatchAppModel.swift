import Foundation
import SwiftUI
import UserNotifications
import WatchKit

@MainActor
final class WatchAppModel: ObservableObject {
  static let shared = WatchAppModel()

  @Published var settings = WatchSettings()
  @Published var statusMessage = "권한을 요청하고 토큰을 등록해 주세요."
  @Published var deviceToken = ""
  @Published var recentNotifications: [WatchNotificationItem] = []

  private let defaults = UserDefaults.standard
  private let registrar = WatchPushRegistrar()
  private var didBootstrap = false

  private init() {
  }

  func bootstrap() {
    guard !didBootstrap else {
      return
    }

    didBootstrap = true
    loadPersistedState()
    requestPermissionAndToken()
  }

  func saveSettings() {
    if let data = try? JSONEncoder().encode(settings) {
      defaults.set(data, forKey: "octop.watch.settings")
      statusMessage = "설정을 저장했습니다."
    }
  }

  func requestPermissionAndToken() {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
      Task { @MainActor in
        if let error {
          self.statusMessage = "권한 요청 실패: \(error.localizedDescription)"
          return
        }

        guard granted else {
          self.statusMessage = "알림 권한이 거부되었습니다."
          return
        }

        self.statusMessage = "토큰을 요청하는 중입니다."
        WKApplication.shared().registerForRemoteNotifications()
      }
    }
  }

  func updateDeviceToken(_ tokenData: Data) {
    deviceToken = tokenData.map { String(format: "%02x", $0) }.joined()
    defaults.set(deviceToken, forKey: "octop.watch.deviceToken")
    statusMessage = "워치 푸시 토큰을 확보했습니다."
  }

  func markTokenFailure(_ error: Error) {
    statusMessage = "토큰 등록 실패: \(error.localizedDescription)"
  }

  func registerCurrentToken() async {
    do {
      let response = try await registrar.register(settings: settings, deviceToken: deviceToken)
      statusMessage = "등록 완료: \(response)"
    } catch WatchRegistrationError.message(let message) {
      statusMessage = message
    } catch {
      statusMessage = "등록 실패: \(error.localizedDescription)"
    }
  }

  func recordNotification(userInfo: [AnyHashable: Any]) {
    let aps = userInfo["aps"] as? [String: Any]
    let alert = aps?["alert"] as? [String: Any]
    let title = (alert?["title"] as? String) ?? (userInfo["title"] as? String) ?? "OctOP"
    let body = (alert?["body"] as? String) ?? (userInfo["body"] as? String) ?? "새 알림"
    let launchURL = (userInfo["launchUrl"] as? String) ?? "/"
    let next = WatchNotificationItem(title: title, body: body, receivedAt: Date(), launchURL: launchURL)
    recentNotifications.insert(next, at: 0)
    recentNotifications = Array(recentNotifications.prefix(10))
    statusMessage = "알림 수신: \(title)"

    if let data = try? JSONEncoder().encode(recentNotifications) {
      defaults.set(data, forKey: "octop.watch.notifications")
    }
  }

  private func loadPersistedState() {
    if let settingsData = defaults.data(forKey: "octop.watch.settings"),
       let decoded = try? JSONDecoder().decode(WatchSettings.self, from: settingsData) {
      settings = decoded
    }

    deviceToken = defaults.string(forKey: "octop.watch.deviceToken") ?? ""

    if let notificationsData = defaults.data(forKey: "octop.watch.notifications"),
       let decoded = try? JSONDecoder().decode([WatchNotificationItem].self, from: notificationsData) {
      recentNotifications = decoded
    }
  }
}
