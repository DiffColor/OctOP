import Foundation

struct WatchSettings: Codable {
  var gatewayURL: String = ""
  var loginId: String = ""
  var bridgeId: String = ""
  var apnsTopic: String = ""
}

struct WatchNotificationItem: Codable, Identifiable {
  let id: UUID
  let title: String
  let body: String
  let receivedAt: Date
  let launchURL: String

  init(id: UUID = UUID(), title: String, body: String, receivedAt: Date, launchURL: String) {
    self.id = id
    self.title = title
    self.body = body
    self.receivedAt = receivedAt
    self.launchURL = launchURL
  }
}
