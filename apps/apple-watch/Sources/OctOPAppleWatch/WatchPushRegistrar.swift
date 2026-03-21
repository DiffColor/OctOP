import Foundation

struct WatchPushRegistrar {
  func register(settings: WatchSettings, deviceToken: String) async throws -> String {
    guard !settings.gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw WatchRegistrationError.message("Gateway URL이 필요합니다.")
    }

    guard !settings.loginId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw WatchRegistrationError.message("Login ID가 필요합니다.")
    }

    guard !settings.bridgeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw WatchRegistrationError.message("Bridge ID가 필요합니다.")
    }

    guard !deviceToken.isEmpty else {
      throw WatchRegistrationError.message("워치 푸시 토큰이 없습니다.")
    }

    var components = URLComponents(string: settings.gatewayURL.trimmingCharacters(in: .whitespacesAndNewlines))
    components?.path = "/api/push/subscriptions"
    components?.queryItems = [
      URLQueryItem(name: "login_id", value: settings.loginId.trimmingCharacters(in: .whitespacesAndNewlines)),
      URLQueryItem(name: "bridge_id", value: settings.bridgeId.trimmingCharacters(in: .whitespacesAndNewlines)),
      URLQueryItem(name: "app_id", value: "apple-watch")
    ]

    guard let url = components?.url else {
      throw WatchRegistrationError.message("Gateway URL 형식이 올바르지 않습니다.")
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(RegisterPayload(
      deviceToken: deviceToken,
      deviceName: "Apple Watch",
      installationId: String(deviceToken.suffix(24)),
      nativePlatform: "watchos",
      packageName: "app.octop.applewatch",
      apnsTopic: settings.apnsTopic.trimmingCharacters(in: .whitespacesAndNewlines),
      clientMode: "standalone"
    ))

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw WatchRegistrationError.message("응답을 확인할 수 없습니다.")
    }

    let body = String(data: data, encoding: .utf8) ?? ""

    guard (200...299).contains(httpResponse.statusCode) else {
      throw WatchRegistrationError.message("등록 실패(\(httpResponse.statusCode)): \(body)")
    }

    return body
  }
}

private struct RegisterPayload: Codable {
  let deviceToken: String
  let deviceName: String
  let installationId: String
  let nativePlatform: String
  let packageName: String
  let apnsTopic: String
  let clientMode: String
}

enum WatchRegistrationError: Error {
  case message(String)
}
