import SwiftUI
import UserNotifications
import WatchKit

@main
struct OctOPAppleWatchApp: App {
  @WKExtensionDelegateAdaptor(WatchRuntimeDelegate.self) private var extensionDelegate
  @StateObject private var model = WatchAppModel.shared

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        List {
          Section("상태") {
            Text(model.statusMessage)
            if model.deviceToken.isEmpty {
              Text("워치 푸시 토큰이 아직 없습니다.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else {
              Text(model.deviceToken)
                .font(.footnote)
            }
          }

          Section("연결 설정") {
            TextField("Gateway URL", text: $model.settings.gatewayURL)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
            TextField("Login ID", text: $model.settings.loginId)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
            TextField("Bridge ID", text: $model.settings.bridgeId)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
            TextField("APNs Topic", text: $model.settings.apnsTopic)
              .textInputAutocapitalization(.never)
              .disableAutocorrection(true)
            Button("설정 저장") {
              model.saveSettings()
            }
            Button("권한 요청 및 토큰 갱신") {
              model.requestPermissionAndToken()
            }
            Button("토큰 등록") {
              Task {
                await model.registerCurrentToken()
              }
            }
          }

          Section("최근 알림") {
            if model.recentNotifications.isEmpty {
              Text("최근 알림이 없습니다.")
                .foregroundStyle(.secondary)
            } else {
              ForEach(model.recentNotifications) { item in
                VStack(alignment: .leading, spacing: 4) {
                  Text(item.title)
                    .font(.headline)
                  Text(item.body)
                    .font(.footnote)
                  Text(item.launchURL)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                  Text(item.receivedAt.formatted(date: .numeric, time: .standard))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        .navigationTitle("OctOP Watch")
      }
      .task {
        model.bootstrap()
      }
    }
  }
}
