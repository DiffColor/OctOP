import Foundation
import UserNotifications
import WatchKit

final class WatchRuntimeDelegate: NSObject, WKExtensionDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching() {
    UNUserNotificationCenter.current().delegate = self
  }

  func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
    Task { @MainActor in
      WatchAppModel.shared.updateDeviceToken(deviceToken)
    }
  }

  func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
    Task { @MainActor in
      WatchAppModel.shared.markTokenFailure(error)
    }
  }

  func didReceiveRemoteNotification(
    _ userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (WKBackgroundFetchResult) -> Void
  ) {
    Task { @MainActor in
      WatchAppModel.shared.recordNotification(userInfo: userInfo)
      completionHandler(.newData)
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    await MainActor.run {
      WatchAppModel.shared.recordNotification(userInfo: notification.request.content.userInfo)
    }
    return [.badge, .sound, .banner]
  }
}
