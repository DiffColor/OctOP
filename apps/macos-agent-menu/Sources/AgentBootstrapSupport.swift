import AppKit
import CryptoKit
import Darwin
import Foundation
import Security
import SwiftUI

private struct LocalCodexAuthStoreStatus {
  let loggedIn: Bool
  let summary: String
}

private enum AgentMenuKeychain {
  static let service = "app.diffcolor.octop.agentmenu"
  static let codexApiKeyAccount = "codex_api_key"

  static func save(_ value: String, account: String) throws {
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]

    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess {
      return
    }

    if updateStatus != errSecItemNotFound {
      throw NSError(
        domain: NSOSStatusErrorDomain,
        code: Int(updateStatus),
        userInfo: [NSLocalizedDescriptionKey: "Keychain 저장 실패: \(updateStatus)"]
      )
    }

    var insertQuery = query
    insertQuery[kSecValueData as String] = data
    insertQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let insertStatus = SecItemAdd(insertQuery as CFDictionary, nil)

    guard insertStatus == errSecSuccess else {
      throw NSError(
        domain: NSOSStatusErrorDomain,
        code: Int(insertStatus),
        userInfo: [NSLocalizedDescriptionKey: "Keychain 저장 실패: \(insertStatus)"]
      )
    }
  }

  static func read(account: String) throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      return nil
    }

    guard status == errSecSuccess,
          let data = item as? Data,
          let value = String(data: data, encoding: .utf8) else {
      throw NSError(
        domain: NSOSStatusErrorDomain,
        code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "Keychain 읽기 실패: \(status)"]
      )
    }

    return value
  }

  static func delete(account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]

    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw NSError(
        domain: NSOSStatusErrorDomain,
        code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "Keychain 삭제 실패: \(status)"]
      )
    }
  }
}

struct RuntimeUpdateDescriptor: Equatable {
  let sourceRevision: String
  let currentSourceRevision: String?
  let sourceContentRevision: String
  let currentSourceContentRevision: String?

  init(
    sourceRevision: String,
    currentSourceRevision: String?,
    sourceContentRevision: String? = nil,
    currentSourceContentRevision: String? = nil
  ) {
    self.sourceRevision = sourceRevision
    self.currentSourceRevision = currentSourceRevision
    self.sourceContentRevision = sourceContentRevision ?? sourceRevision
    self.currentSourceContentRevision = currentSourceContentRevision ?? currentSourceRevision
  }

  var displayRevision: String {
    String(sourceRevision.prefix(12))
  }

  var currentDisplayRevision: String? {
    guard let currentSourceRevision else {
      return nil
    }

    return String(currentSourceRevision.prefix(12))
  }
}

private enum AgentLoginDebugLog {
  private static var logURL: URL {
    let baseURL = octopAgentMenuAppSupportURL()
    return baseURL.appendingPathComponent("login-debug.log")
  }

  static func write(_ message: String) {
    let formatter = ISO8601DateFormatter()
    let line = "[\(formatter.string(from: Date()))] \(message)\n"
    let data = Data(line.utf8)

    do {
      try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      if FileManager.default.fileExists(atPath: logURL.path) {
        let handle = try FileHandle(forWritingTo: logURL)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
      } else {
        try data.write(to: logURL, options: .atomic)
      }
    } catch {
    }
  }
}

func octopAgentMenuAppSupportURL() -> URL {
  if let overridePath = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_SUPPORT_PATH"]?
    .trimmingCharacters(in: .whitespacesAndNewlines),
     !overridePath.isEmpty {
    return URL(fileURLWithPath: overridePath, isDirectory: true).standardizedFileURL
  }

  return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
    .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
    ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/OctOPAgentMenu", isDirectory: true)
}

private func decodeJWTClaims(_ token: String) -> [String: Any]? {
  let segments = token.split(separator: ".")
  guard segments.count >= 2 else {
    return nil
  }

  var base64 = String(segments[1])
    .replacingOccurrences(of: "-", with: "+")
    .replacingOccurrences(of: "_", with: "/")

  let remainder = base64.count % 4
  if remainder != 0 {
    base64 += String(repeating: "=", count: 4 - remainder)
  }

  guard let data = Data(base64Encoded: base64),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    return nil
  }

  return json
}

private func localCodexAuthStoreStatus(at codexHomeURL: URL) -> LocalCodexAuthStoreStatus? {
  let authURL = codexHomeURL.appendingPathComponent("auth.json")
  guard let data = try? Data(contentsOf: authURL),
        let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    return nil
  }

  if let apiKey = raw["OPENAI_API_KEY"] as? String,
     !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return LocalCodexAuthStoreStatus(loggedIn: true, summary: "API Key 로그인됨")
  }

  guard let tokens = raw["tokens"] as? [String: Any] else {
    return nil
  }

  let candidateTokens = [
    tokens["id_token"] as? String,
    tokens["access_token"] as? String
  ].compactMap { token in
    let value = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? nil : value
  }

  guard !candidateTokens.isEmpty else {
    return nil
  }

  for token in candidateTokens {
    guard let claims = decodeJWTClaims(token) else {
      continue
    }

    if let email = claims["email"] as? String,
       !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return LocalCodexAuthStoreStatus(loggedIn: true, summary: email)
    }

    if let profile = claims["https://api.openai.com/profile"] as? [String: Any],
       let email = profile["email"] as? String,
       !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return LocalCodexAuthStoreStatus(loggedIn: true, summary: email)
    }
  }

  return LocalCodexAuthStoreStatus(loggedIn: true, summary: "로그인됨")
}

private struct CodexBrowserOption: Identifiable {
  let id: String
  let displayName: String
  let appURL: URL
  let icon: NSImage
}

private enum CodexBrowserOpenError: LocalizedError {
  case emptyBrowserID
  case openFailed(Int32)

  var errorDescription: String? {
    switch self {
    case .emptyBrowserID:
      return "선택한 브라우저 정보가 비어 있습니다."
    case .openFailed(let status):
      return "브라우저 실행에 실패했습니다. open 종료 코드: \(status)"
    }
  }
}

@MainActor
private final class CodexBrowserPickerController: NSObject {
  let panel: NSPanel
  let optionsById: [String: CodexBrowserOption]
  let completion: (CodexBrowserOption?) -> Void
  weak var presentingWindow: NSWindow?

  init(
    panel: NSPanel,
    optionsById: [String: CodexBrowserOption],
    presentingWindow: NSWindow?,
    completion: @escaping (CodexBrowserOption?) -> Void
  ) {
    self.panel = panel
    self.optionsById = optionsById
    self.presentingWindow = presentingWindow
    self.completion = completion
  }

  @objc func chooseBrowser(_ sender: NSButton) {
    guard let identifier = sender.identifier?.rawValue,
          let option = optionsById[identifier] else {
      return
    }

    close(with: option)
  }

  @objc func cancel(_ sender: NSButton) {
    close(with: nil)
  }

  private func close(with selection: CodexBrowserOption?) {
    if let presentingWindow {
      presentingWindow.endSheet(panel)
    } else {
      panel.orderOut(nil)
    }

    completion(selection)
  }
}

private enum CodexBrowserSelection {
  @MainActor
  private static var activeControllers: [ObjectIdentifier: CodexBrowserPickerController] = [:]

  private static let browserCandidates: [(bundleID: String, displayName: String)] = [
    ("com.apple.Safari", "Safari"),
    ("com.google.Chrome", "Google Chrome"),
    ("com.microsoft.edgemac", "Microsoft Edge"),
    ("company.thebrowser.Browser", "Arc"),
    ("com.brave.Browser", "Brave"),
    ("org.mozilla.firefox", "Firefox")
  ]

  @MainActor
  static func selectBrowserID() async -> String? {
    let browsers = discoverBrowsers()
    guard !browsers.isEmpty else {
      return nil
    }

    return await withCheckedContinuation { continuation in
      let panel = NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 760, height: 320),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
      )
      panel.title = "브라우저 선택"
      panel.isReleasedWhenClosed = false

      let contentView = NSView(frame: panel.contentView?.bounds ?? .zero)
      contentView.translatesAutoresizingMaskIntoConstraints = false

      let titleLabel = NSTextField(labelWithString: "로그인에 사용할 브라우저를 선택해 주세요.")
      titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)

      let subtitleLabel = NSTextField(labelWithString: "기본 브라우저 대신 다른 브라우저를 선택해 로그인할 수 있습니다.")
      subtitleLabel.textColor = .secondaryLabelColor
      subtitleLabel.font = .systemFont(ofSize: 12)

      let buttonStack = NSStackView()
      buttonStack.orientation = .horizontal
      buttonStack.spacing = 28
      buttonStack.alignment = .centerY
      buttonStack.distribution = .gravityAreas

      var optionMap: [String: CodexBrowserOption] = [:]
      var optionButtons: [NSButton] = []
      for browser in browsers {
        optionMap[browser.id] = browser

        let (tile, button) = makeBrowserTile(for: browser)
        optionButtons.append(button)
        buttonStack.addArrangedSubview(tile)
      }

      let cancelButton = NSButton(title: "취소", target: nil, action: nil)
      cancelButton.bezelStyle = .rounded

      let rootStack = NSStackView(views: [titleLabel, subtitleLabel, buttonStack, cancelButton])
      rootStack.orientation = .vertical
      rootStack.spacing = 12
      rootStack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
      rootStack.translatesAutoresizingMaskIntoConstraints = false

      contentView.addSubview(rootStack)
      panel.contentView = contentView

      NSLayoutConstraint.activate([
        rootStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
        rootStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
        rootStack.topAnchor.constraint(greaterThanOrEqualTo: contentView.topAnchor),
        rootStack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor),
        rootStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor)
      ])

      let presentingWindow = NSApp.keyWindow ?? NSApp.mainWindow
      let panelIdentifier = ObjectIdentifier(panel)
      let controller = CodexBrowserPickerController(
        panel: panel,
        optionsById: optionMap,
        presentingWindow: presentingWindow,
        completion: { selection in
          activeControllers.removeValue(forKey: panelIdentifier)
          continuation.resume(returning: selection?.id)
        }
      )
      activeControllers[panelIdentifier] = controller

      for button in optionButtons {
        button.target = controller
        button.action = #selector(CodexBrowserPickerController.chooseBrowser(_:))
      }
      cancelButton.target = controller
      cancelButton.action = #selector(CodexBrowserPickerController.cancel(_:))

      NSApp.activate(ignoringOtherApps: true)
      panel.center()
      if let presentingWindow {
        presentingWindow.beginSheet(panel)
      } else {
        panel.makeKeyAndOrderFront(nil)
      }
    }
  }

  @MainActor
  static func open(_ url: URL, usingBrowserID browserID: String) throws {
    guard !browserID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      AgentLoginDebugLog.write("browser open skipped: empty browser id")
      throw CodexBrowserOpenError.emptyBrowserID
    }

    AgentLoginDebugLog.write("browser open start: bundle=\(browserID) url=\(url.absoluteString)")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-b", browserID, url.absoluteString]

    try process.run()
    process.waitUntilExit()
    AgentLoginDebugLog.write("browser open exit: bundle=\(browserID) status=\(process.terminationStatus)")

    guard process.terminationStatus == 0 else {
      throw CodexBrowserOpenError.openFailed(process.terminationStatus)
    }
  }

  @MainActor
  private static func discoverBrowsers() -> [CodexBrowserOption] {
    browserCandidates.compactMap { candidate in
      guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: candidate.bundleID) else {
        return nil
      }

      let icon = NSWorkspace.shared.icon(forFile: appURL.path)
      icon.size = NSSize(width: 64, height: 64)
      return CodexBrowserOption(
        id: candidate.bundleID,
        displayName: candidate.displayName,
        appURL: appURL,
        icon: icon
      )
    }
  }

  @MainActor
  private static func makeBrowserTile(for browser: CodexBrowserOption) -> (NSView, NSButton) {
    let button = NSButton(title: "", target: nil, action: nil)
    button.identifier = NSUserInterfaceItemIdentifier(browser.id)
    button.setButtonType(.momentaryPushIn)
    button.isBordered = false
    button.translatesAutoresizingMaskIntoConstraints = false
    button.image = browser.icon
    button.imageScaling = .scaleProportionallyUpOrDown
    button.imagePosition = .imageOnly
    button.widthAnchor.constraint(equalToConstant: 104).isActive = true
    button.heightAnchor.constraint(equalToConstant: 104).isActive = true

    let label = NSTextField(labelWithString: browser.displayName)
    label.alignment = .center
    label.lineBreakMode = .byWordWrapping
    label.maximumNumberOfLines = 2
    label.font = .systemFont(ofSize: 13, weight: .regular)
    label.textColor = .labelColor
    label.translatesAutoresizingMaskIntoConstraints = false
    label.widthAnchor.constraint(equalToConstant: 132).isActive = true

    let stack = NSStackView(views: [button, label])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 0, bottom: 20, right: 0)
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.setHuggingPriority(.required, for: .horizontal)
    return (stack, button)
  }
}

struct AgentLaunchContext {
  let nodeExecutableURL: URL
  let workspaceURL: URL
  let environment: [String: String]
}

private func currentAgentMenuBundleVersionTag() -> String {
  currentAgentMenuVersionTag()
}

private struct AgentRuntimeReleaseBuildInfo: Codable {
  let runtimeID: String
  let sourceHash: String
  let configurationHash: String
  let sourceRevision: String?
  let sourceContentRevision: String?
  let appVersion: String
  let createdAt: Date
}

private struct AgentRuntimeReleaseHealthcheck: Codable {
  let status: String
  let checkedAt: Date
  let checks: [String]
}

private struct PendingAppUpdateState: Codable {
  let targetTag: String
  let currentAppPath: String
  let appSupportExistedAtBackup: Bool
  let preparedAt: Date
  var launchConfirmedAt: Date?
}

private struct BrowserLoginHelperResult: Sendable {
  let loggedIn: Bool
  let summary: String
}

private struct PendingLoginState: Codable {
  let loginId: String
  let startedAt: Date
}

private struct AgentPreparedRuntimeSource {
  let rootURL: URL
  let sourceRevision: String?
  let sourceContentRevision: String
}

private struct AgentPreparedCodexAdapterSource {
  let sourceURL: URL
  let sourceRevision: String?
  let sourceContentRevision: String
}

struct AgentDiagnosticItem: Identifiable {
  let id = UUID()
  let title: String
  let detail: String
  let status: Status

  enum Status: String {
    case ok = "정상"
    case warning = "주의"
    case missing = "없음"
  }
}

struct AgentBootstrapConfiguration: Codable {
  static let authModeDeviceAuth = "chatgpt-login"
  static let authModeApiKey = "api-key"
  static let dangerouslyBypassApprovalsAndSandbox = "dangerously-bypass-approvals-and-sandbox"

  private static let validAuthModes: Set<String> = [authModeDeviceAuth, authModeApiKey]
  static let chatGptAuthMode = authModeDeviceAuth

  static func normalizedAuthMode(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return validAuthModes.contains(trimmed) ? trimmed : authModeDeviceAuth
  }

  static func isApiKeyAuthMode(_ value: String) -> Bool {
    normalizedAuthMode(value) == authModeApiKey
  }

  var ownerLoginId: String
  var deviceName: String
  var workspaceRoots: String
  var natsUrl: String
  var bridgeHost: String
  var bridgePort: String
  var bridgeToken: String
  var appServerMode: String
  var appServerWsUrl: String
  var codexModel: String
  var reasoningEffort: String
  var approvalPolicy: String
  var sandboxMode: String
  var watchdogIntervalMs: String
  var staleMs: String
  var autoStartAtLogin: Bool
  var authMode: String
  var authApiKey: String

  enum CodingKeys: String, CodingKey {
    case ownerLoginId
    case deviceName
    case workspaceRoots
    case natsUrl
    case bridgeHost
    case bridgePort
    case bridgeToken
    case appServerMode
    case appServerWsUrl
    case codexModel
    case reasoningEffort
    case approvalPolicy
    case sandboxMode
    case watchdogIntervalMs
    case staleMs
    case autoStartAtLogin
    case authMode
    case authApiKey
  }

  init(
    ownerLoginId: String,
    deviceName: String,
    workspaceRoots: String,
    natsUrl: String,
    bridgeHost: String,
    bridgePort: String,
    bridgeToken: String,
    appServerMode: String,
    appServerWsUrl: String,
    codexModel: String,
    reasoningEffort: String,
    approvalPolicy: String,
    sandboxMode: String,
    watchdogIntervalMs: String,
    staleMs: String,
    autoStartAtLogin: Bool,
    authMode: String,
    authApiKey: String = ""
  ) {
    self.ownerLoginId = ownerLoginId
    self.deviceName = deviceName
    self.workspaceRoots = workspaceRoots
    self.natsUrl = natsUrl
    self.bridgeHost = bridgeHost
    self.bridgePort = bridgePort
    self.bridgeToken = bridgeToken
    self.appServerMode = appServerMode
    self.appServerWsUrl = appServerWsUrl
    self.codexModel = codexModel
    self.reasoningEffort = reasoningEffort
    self.approvalPolicy = approvalPolicy
    self.sandboxMode = sandboxMode
    self.watchdogIntervalMs = watchdogIntervalMs
    self.staleMs = staleMs
    self.autoStartAtLogin = autoStartAtLogin
    self.authMode = authMode
    self.authApiKey = authApiKey
  }

  static func currentDeviceName() -> String {
    let host = Host.current().localizedName ?? Host.current().name ?? ""
    return host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "My Mac" : host
  }

  static func `default`() -> AgentBootstrapConfiguration {
    return AgentBootstrapConfiguration(
      ownerLoginId: NSUserName(),
      deviceName: currentDeviceName(),
      workspaceRoots: NSString(string: "~/Documents/Workspaces").expandingTildeInPath,
      natsUrl: "nats://ilysrv.ddns.net:4222",
      bridgeHost: "0.0.0.0",
      bridgePort: "4100",
      bridgeToken: "octop-local-bridge",
      appServerMode: "ws-local",
      appServerWsUrl: "ws://127.0.0.1:4600",
      codexModel: "gpt-5.4",
      reasoningEffort: "high",
      approvalPolicy: "on-request",
      sandboxMode: "danger-full-access",
      watchdogIntervalMs: "15000",
      staleMs: "120000",
      autoStartAtLogin: true,
      authMode: authModeDeviceAuth,
      authApiKey: ""
    )
  }

  mutating func normalize() {
    if deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      deviceName = Self.currentDeviceName()
    }

    authMode = Self.authModeDeviceAuth
    authApiKey = authApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  init(from decoder: Decoder) throws {
    let defaults = Self.default()
    let container = try decoder.container(keyedBy: CodingKeys.self)
    ownerLoginId = try container.decodeIfPresent(String.self, forKey: .ownerLoginId) ?? defaults.ownerLoginId
    deviceName = try container.decodeIfPresent(String.self, forKey: .deviceName) ?? defaults.deviceName
    workspaceRoots = try container.decodeIfPresent(String.self, forKey: .workspaceRoots) ?? defaults.workspaceRoots
    natsUrl = try container.decodeIfPresent(String.self, forKey: .natsUrl) ?? defaults.natsUrl
    bridgeHost = try container.decodeIfPresent(String.self, forKey: .bridgeHost) ?? defaults.bridgeHost
    bridgePort = try container.decodeIfPresent(String.self, forKey: .bridgePort) ?? defaults.bridgePort
    bridgeToken = try container.decodeIfPresent(String.self, forKey: .bridgeToken) ?? defaults.bridgeToken
    appServerMode = try container.decodeIfPresent(String.self, forKey: .appServerMode) ?? defaults.appServerMode
    appServerWsUrl = try container.decodeIfPresent(String.self, forKey: .appServerWsUrl) ?? defaults.appServerWsUrl
    codexModel = try container.decodeIfPresent(String.self, forKey: .codexModel) ?? defaults.codexModel
    reasoningEffort = try container.decodeIfPresent(String.self, forKey: .reasoningEffort) ?? defaults.reasoningEffort
    approvalPolicy = try container.decodeIfPresent(String.self, forKey: .approvalPolicy) ?? defaults.approvalPolicy
    sandboxMode = try container.decodeIfPresent(String.self, forKey: .sandboxMode) ?? defaults.sandboxMode
    watchdogIntervalMs = try container.decodeIfPresent(String.self, forKey: .watchdogIntervalMs) ?? defaults.watchdogIntervalMs
    staleMs = try container.decodeIfPresent(String.self, forKey: .staleMs) ?? defaults.staleMs
    autoStartAtLogin = try container.decodeIfPresent(Bool.self, forKey: .autoStartAtLogin) ?? defaults.autoStartAtLogin
    authMode = try container.decodeIfPresent(String.self, forKey: .authMode) ?? defaults.authMode
    authApiKey = try container.decodeIfPresent(String.self, forKey: .authApiKey) ?? defaults.authApiKey
    normalize()
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(ownerLoginId, forKey: .ownerLoginId)
    try container.encode(deviceName, forKey: .deviceName)
    try container.encode(workspaceRoots, forKey: .workspaceRoots)
    try container.encode(natsUrl, forKey: .natsUrl)
    try container.encode(bridgeHost, forKey: .bridgeHost)
    try container.encode(bridgePort, forKey: .bridgePort)
    try container.encode(bridgeToken, forKey: .bridgeToken)
    try container.encode(appServerMode, forKey: .appServerMode)
    try container.encode(appServerWsUrl, forKey: .appServerWsUrl)
    try container.encode(codexModel, forKey: .codexModel)
    try container.encode(reasoningEffort, forKey: .reasoningEffort)
    try container.encode(approvalPolicy, forKey: .approvalPolicy)
    try container.encode(sandboxMode, forKey: .sandboxMode)
    try container.encode(watchdogIntervalMs, forKey: .watchdogIntervalMs)
    try container.encode(staleMs, forKey: .staleMs)
    try container.encode(autoStartAtLogin, forKey: .autoStartAtLogin)
    try container.encode(authMode, forKey: .authMode)
    try container.encode(authApiKey, forKey: .authApiKey)
  }
}

enum AgentBootstrapError: LocalizedError {
  case appSupportUnavailable
  case bundleBootstrapUnavailable
  case nodeUnavailable
  case codexUnavailable
  case npmUnavailable

  var errorDescription: String? {
    switch self {
    case .appSupportUnavailable:
      return "Application Support 경로를 확인할 수 없습니다."
    case .bundleBootstrapUnavailable:
      return "앱에 포함된 bootstrap 리소스를 찾지 못했습니다."
    case .nodeUnavailable:
      return "node를 설치하거나 가져오지 못했습니다."
    case .codexUnavailable:
      return "codex를 설치하거나 가져오지 못했습니다."
    case .npmUnavailable:
      return "npm 실행 경로를 찾지 못했습니다."
    }
  }
}

private final class ProcessOutputBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []

  func append(_ line: String) {
    lock.lock()
    lines.append(line)
    if lines.count > 20 {
      lines.removeFirst(lines.count - 20)
    }
    lock.unlock()
  }

  func joinedSummary() -> String {
    lock.lock()
    let summary = lines
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: "\n")
    lock.unlock()
    return summary
  }
}

private final class BrowserLoginHelperState: @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false
  private var result = BrowserLoginHelperResult(loggedIn: false, summary: "미로그인")

  func markFinished() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if finished {
      return false
    }
    finished = true
    return true
  }

  func setResult(_ value: BrowserLoginHelperResult) {
    lock.lock()
    result = value
    lock.unlock()
  }

  func snapshot() -> BrowserLoginHelperResult {
    lock.lock()
    let value = result
    lock.unlock()
    return value
  }
}

@MainActor
final class AgentBootstrapStore: ObservableObject {
  private static let knownModelOptions = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5-codex",
    "gpt-5-codex-mini",
    "gpt-5"
  ]

  @Published var configuration: AgentBootstrapConfiguration
  @Published var diagnostics: [AgentDiagnosticItem] = []
  @Published var bootstrapInProgress = false
  @Published var codexLoginInProgress = false
  @Published var bootstrapSummary = "환경설정 필요"
  @Published var codexLoginStatus = ""
  @Published var codexLoggedIn = false
  @Published var codexLoginStatusResolved = false
  @Published var authApiKeyInput = ""
  @Published var configurationSavedAt: Date? = nil
  @Published var lastBootstrapAt: Date? = nil
  @Published var availableAppUpdate: AppUpdateDescriptor? = nil
  @Published var availableRuntimeUpdate: RuntimeUpdateDescriptor? = nil
  @Published var appUpdateCheckInProgress = false
  @Published var appUpdateInProgress = false
  @Published var lastAppUpdateCheckError: String? = nil
  @Published var runtimeUpdateCheckInProgress = false
  @Published var lastRuntimeUpdateCheckError: String? = nil
  private var automaticBootstrapAttempted = false
  private var pendingLoginRecoveryAttempted = false
  private var bootstrapTask: Task<Bool, Never>? = nil
  var runtimeUpdateRevisionResolver: ((AgentBootstrapStore) async throws -> String?)? = nil

  init() {
    configuration = Self.loadConfiguration() ?? .default()
    migrateLegacyApiKeyIfNeeded()
    ensureCodexHomeReady()
    refreshDiagnostics()
  }

  let appServerModeOptions = ["ws-local"]
  let reasoningOptions = ["none", "low", "medium", "high", "xhigh"]
  let approvalOptions = ["on-request", "never", "untrusted"]
  let sandboxOptions = [
    AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox,
    "danger-full-access",
    "workspace-write",
    "read-only"
  ]
  let authModeOptions = [
    AgentBootstrapConfiguration.authModeDeviceAuth,
    AgentBootstrapConfiguration.authModeApiKey
  ]

  func approvalOptionLabel(for value: String) -> String {
    switch value.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "on-request":
      return "필요할 때만 승인 요청"
    case "never":
      return "승인 요청 없이 진행"
    case "untrusted":
      return "보수적으로 제한"
    default:
      return value
    }
  }

  func sandboxOptionLabel(for value: String) -> String {
    switch value.trimmingCharacters(in: .whitespacesAndNewlines) {
    case AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox:
      return "승인/샌드박스 완전 우회 (매우 위험)"
    case "danger-full-access":
      return "전체 파일 접근"
    case "workspace-write":
      return "워크스페이스만 쓰기"
    case "read-only":
      return "읽기 전용"
    default:
      return value
    }
  }

  var isAuthModeApiKey: Bool {
    false
  }

  var hasStoredApiKey: Bool {
    !(storedApiKey()?.isEmpty ?? true)
  }

  var modelOptions: [String] {
    let selectedModel = configuration.codexModel.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !selectedModel.isEmpty else {
      return Self.knownModelOptions
    }

    if Self.knownModelOptions.contains(selectedModel) {
      return Self.knownModelOptions
    }

    return [selectedModel] + Self.knownModelOptions
  }

  var appSupportURL: URL {
    octopAgentMenuAppSupportURL()
  }

  var runtimeURL: URL {
    appSupportURL.appendingPathComponent("runtime", isDirectory: true)
  }

  var runtimeReleasesURL: URL {
    runtimeURL.appendingPathComponent("releases", isDirectory: true)
  }

  private var runtimeSourceCacheURL: URL {
    runtimeURL.appendingPathComponent("source-cache", isDirectory: true)
  }

  private var runtimeRepositoryCacheURL: URL {
    runtimeSourceCacheURL.appendingPathComponent("octop-repo", isDirectory: true)
  }

  private var runtimeRepositoryRemoteURL: String {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_RUNTIME_REPO_URL"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overrideValue.isEmpty {
      return overrideValue
    }

    return "https://github.com/DiffColor/OctOP.git"
  }

  private var runtimeRepositoryBranch: String {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_RUNTIME_REPO_BRANCH"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overrideValue.isEmpty {
      return overrideValue
    }

    return "main"
  }

  var runtimeCurrentReleasePointerURL: URL {
    runtimeURL.appendingPathComponent("current-release.txt")
  }

  var runtimePreviousReleasePointerURL: URL {
    runtimeURL.appendingPathComponent("previous-release.txt")
  }

  private var legacyRuntimeWorkspaceURL: URL {
    runtimeURL.appendingPathComponent("workspace", isDirectory: true)
  }

  var codexHomeURL: URL {
    if let overridePath = ProcessInfo.processInfo.environment["CODEX_HOME"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overridePath.isEmpty {
      return URL(fileURLWithPath: overridePath, isDirectory: true).standardizedFileURL
    }

    return URL(fileURLWithPath: NSString(string: "~/.codex").expandingTildeInPath, isDirectory: true)
      .standardizedFileURL
  }

  var stateHomeURL: URL {
    appSupportURL.appendingPathComponent("state", isDirectory: true)
  }

  var runtimeWorkspaceURL: URL {
    currentRuntimeReleaseURL() ?? legacyRuntimeWorkspaceURL
  }

  var activeRuntimeReleaseURL: URL? {
    currentRuntimeReleaseURL()
  }

  var runtimeBinURL: URL {
    runtimeURL.appendingPathComponent("bin", isDirectory: true)
  }

  var runtimeNodePrefixURL: URL {
    runtimeURL.appendingPathComponent("node", isDirectory: true)
  }

  var runtimeNodeURL: URL {
    runtimeNodePrefixURL.appendingPathComponent("bin/node")
  }

  var runtimeNpmCliURL: URL {
    runtimeNodePrefixURL.appendingPathComponent("lib/node_modules/npm/bin/npm-cli.js")
  }

  var runtimeCodexURL: URL {
    runtimeBinURL.appendingPathComponent("codex")
  }

  var runtimeRgURL: URL {
    runtimeBinURL.appendingPathComponent("rg")
  }

  var runtimeEnvURL: URL {
    runtimeWorkspaceURL.appendingPathComponent(".env.local")
  }

  var runtimeVersionURL: URL {
    runtimeWorkspaceURL.appendingPathComponent("version.txt")
  }

  private var runtimeReleaseRetentionLimit: Int {
    3
  }

  var configurationURL: URL {
    appSupportURL.appendingPathComponent("config.json")
  }

  var bridgeIdURL: URL {
    appSupportURL.appendingPathComponent("bridge-id")
  }

  var legacyBridgeIdURL: URL {
    stateHomeURL.appendingPathComponent("bridge-id")
  }

  var pendingLoginURL: URL {
    appSupportURL.appendingPathComponent("pending-login.json")
  }

  var launchAgentURL: URL {
    if let overridePath = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_LAUNCH_AGENT_PATH"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overridePath.isEmpty {
      return URL(fileURLWithPath: overridePath)
    }

    return URL(fileURLWithPath: NSString(string: "~/Library/LaunchAgents/app.diffcolor.octop.agentmenu.launcher.plist").expandingTildeInPath)
  }

  var currentAppVersionTag: String {
    currentAgentMenuBundleVersionTag()
  }

  var currentAppVersionDisplay: String {
    currentAppVersionTag
  }

  var appUpdateDataBackupURL: URL {
    URL(fileURLWithPath: appSupportURL.path + ".update-backup", isDirectory: true)
  }

  private var appUpdateDataBackupStagingURL: URL {
    URL(fileURLWithPath: appSupportURL.path + ".update-backup.staging", isDirectory: true)
  }

  private var appUpdatePreservedAppSupportURL: URL {
    appUpdateDataBackupURL.appendingPathComponent(appSupportURL.lastPathComponent, isDirectory: true)
  }

  private var appUpdateStatusURL: URL {
    appUpdateDataBackupURL.appendingPathComponent("status.json")
  }

  private var appUpdateLaunchMarkerURL: URL {
    appUpdateDataBackupURL.appendingPathComponent("launch-confirmed")
  }

  var appUpdateScriptLogURL: URL {
    appUpdateDataBackupURL.appendingPathComponent("apply-update.log")
  }

  var runtimeUpdateCheckIntervalSeconds: TimeInterval {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_RUNTIME_UPDATE_CHECK_INTERVAL_SECONDS"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       let interval = TimeInterval(overrideValue),
       interval >= 5 {
      return interval
    }

    return 300
  }

  var hasAvailableRuntimeUpdate: Bool {
    availableRuntimeUpdate != nil
  }

  var runtimeUpdateStatusDisplay: String? {
    guard let availableRuntimeUpdate else {
      return nil
    }

    return "업데이트 \(availableRuntimeUpdate.displayRevision)"
  }

  func restorePreservedAppDataIfNeeded(log: @escaping @MainActor (String) -> Void) {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: appUpdatePreservedAppSupportURL.path),
          !fileManager.fileExists(atPath: appSupportURL.path) else {
      return
    }

    do {
      try ensureDirectory(appSupportURL.deletingLastPathComponent())
      try fileManager.copyItem(at: appUpdatePreservedAppSupportURL, to: appSupportURL)
      log("업데이트 백업에서 앱 로컬 데이터를 복구했습니다.")
    } catch {
      log("업데이트 백업 복구 실패: \(error.localizedDescription)")
    }
  }

  func preserveAppDataForUpdate(
    currentAppURL: URL = Bundle.main.bundleURL,
    targetTag: String,
    log: @escaping @MainActor (String) -> Void
  ) throws {
    let fileManager = FileManager.default
    let appSupportExists = fileManager.fileExists(atPath: appSupportURL.path)

    if fileManager.fileExists(atPath: appUpdateDataBackupStagingURL.path) {
      try fileManager.removeItem(at: appUpdateDataBackupStagingURL)
    }

    try ensureDirectory(appUpdateDataBackupStagingURL.deletingLastPathComponent())
    try ensureDirectory(appUpdateDataBackupStagingURL)

    do {
      if appSupportExists {
        let backupURL = appUpdateDataBackupStagingURL.appendingPathComponent(appSupportURL.lastPathComponent, isDirectory: true)
        try fileManager.copyItem(at: appSupportURL, to: backupURL)
      }

      if fileManager.fileExists(atPath: appUpdateDataBackupURL.path) {
        try fileManager.removeItem(at: appUpdateDataBackupURL)
      }

      try fileManager.moveItem(at: appUpdateDataBackupStagingURL, to: appUpdateDataBackupURL)
      try writePendingAppUpdateState(
        PendingAppUpdateState(
          targetTag: targetTag,
          currentAppPath: currentAppURL.standardizedFileURL.path,
          appSupportExistedAtBackup: appSupportExists,
          preparedAt: Date(),
          launchConfirmedAt: nil
        )
      )
      if fileManager.fileExists(atPath: appUpdateLaunchMarkerURL.path) {
        try fileManager.removeItem(at: appUpdateLaunchMarkerURL)
      }
      if fileManager.fileExists(atPath: appUpdateScriptLogURL.path) {
        try fileManager.removeItem(at: appUpdateScriptLogURL)
      }
      log("앱 업데이트에 대비해 앱 로컬 데이터 전체를 백업했습니다.")
    } catch {
      if fileManager.fileExists(atPath: appUpdateDataBackupStagingURL.path) {
        try? fileManager.removeItem(at: appUpdateDataBackupStagingURL)
      }

      throw error
    }
  }

  func markPendingAppUpdateLaunchSucceededIfNeeded(
    currentAppURL: URL = Bundle.main.bundleURL,
    log: @escaping @MainActor (String) -> Void
  ) {
    guard var pendingState = loadPendingAppUpdateState(),
          pendingState.currentAppPath == currentAppURL.standardizedFileURL.path,
          pendingState.launchConfirmedAt == nil else {
      return
    }

    pendingState.launchConfirmedAt = Date()

    do {
      try writePendingAppUpdateState(pendingState)
      try "ok".write(to: appUpdateLaunchMarkerURL, atomically: true, encoding: .utf8)
      log("새 앱 번들 기동을 확인했습니다. 업데이트 정리 대기 상태로 전환합니다.")
    } catch {
      log("새 앱 번들 기동 확인 기록 실패: \(error.localizedDescription)")
    }
  }

  func cleanupCompletedAppUpdateArtifacts(
    currentAppURL: URL = Bundle.main.bundleURL,
    log: @escaping @MainActor (String) -> Void
  ) {
    let fileManager = FileManager.default
    if let pendingState = loadPendingAppUpdateState(),
       pendingState.currentAppPath == currentAppURL.standardizedFileURL.path,
       pendingState.launchConfirmedAt == nil {
      log("앱 업데이트 정리를 보류합니다. 새 앱 기동 확인 마커가 아직 없습니다.")
      return
    }

    let cleanupTargets = [
      URL(fileURLWithPath: currentAppURL.path + ".previous-update", isDirectory: true),
      appUpdateDataBackupURL,
      appUpdateDataBackupStagingURL,
      URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
        .appendingPathComponent("updates", isDirectory: true)
    ]

    var removedItems: [String] = []

    for target in cleanupTargets {
      guard fileManager.fileExists(atPath: target.path) else {
        continue
      }

      do {
        try fileManager.removeItem(at: target)
        removedItems.append(target.lastPathComponent)
      } catch {
        log("업데이트 백업 정리 실패: \(target.path) - \(error.localizedDescription)")
      }
    }

    if !removedItems.isEmpty {
      log("업데이트 백업과 임시 파일을 정리했습니다. items=\(removedItems.joined(separator: ","))")
    }
  }

  private func loadPendingAppUpdateState() -> PendingAppUpdateState? {
    guard let data = try? Data(contentsOf: appUpdateStatusURL) else {
      return nil
    }

    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(PendingAppUpdateState.self, from: data)
  }

  private func writePendingAppUpdateState(_ state: PendingAppUpdateState) throws {
    try ensureDirectory(appUpdateDataBackupURL)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(state)
    try data.write(to: appUpdateStatusURL, options: .atomic)
  }

  private func ensureCodexHomeReady(log: ((String) -> Void)? = nil) {
    do {
      try ensureDirectory(codexHomeURL)
    } catch {
      log?("전역 Codex 저장소를 준비하지 못했습니다: \(error.localizedDescription)")
    }
  }

  var runtimeVersionDisplay: String {
    if let activeRuntimeURL = currentRuntimeReleaseURL(),
       let buildInfo = loadRuntimeBuildInfo(at: activeRuntimeURL) {
      let sourceToken = buildInfo.sourceRevision?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let contentToken = buildInfo.sourceContentRevision?
        .trimmingCharacters(in: .whitespacesAndNewlines)

      if let sourceToken, !sourceToken.isEmpty {
        return String(sourceToken.prefix(12))
      }

      if let contentToken, !contentToken.isEmpty {
        return String(contentToken.prefix(12))
      }
    }

    guard FileManager.default.fileExists(atPath: runtimeVersionURL.path),
          let value = try? String(contentsOf: runtimeVersionURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
          !value.isEmpty else {
      return "미설치"
    }

    return Self.normalizeVersionTag(value)
  }

  func saveConfiguration() {
    do {
      try persistApiKeyInputIfNeeded()
      try persistConfiguration()
      try installLaunchAgent(enabled: configuration.autoStartAtLogin, log: { _ in })
      authApiKeyInput = ""
      configurationSavedAt = Date()
      bootstrapSummary = "설정을 저장했습니다."
      refreshDiagnostics()
    } catch {
      bootstrapSummary = "설정 저장 실패: \(error.localizedDescription)"
    }
  }

  func ensureInstalledIfNeeded(log: @escaping @MainActor (String) -> Void) async {
    guard !automaticBootstrapAttempted else {
      return
    }

    automaticBootstrapAttempted = true

    _ = await ensureReadyForLaunch(log: log)
  }

  func refreshCodexLoginStatus() async {
    if codexLoginInProgress {
      return
    }

    ensureCodexHomeReady()
    codexLoginStatusResolved = false
    let status = await currentCodexLoginStatus()
    codexLoggedIn = status.loggedIn
    codexLoginStatus = status.summary
    codexLoginStatusResolved = true
  }

  func refreshAvailableRuntimeUpdate(
    log: @escaping @MainActor (String) -> Void
  ) async {
    guard !runtimeUpdateCheckInProgress else {
      return
    }

    runtimeUpdateCheckInProgress = true
    defer { runtimeUpdateCheckInProgress = false }

    do {
      let nextAvailableUpdate = try await resolveAvailableRuntimeUpdate()
      let previousAvailableUpdate = availableRuntimeUpdate
      availableRuntimeUpdate = nextAvailableUpdate
      lastRuntimeUpdateCheckError = nil

      if let nextAvailableUpdate,
         previousAvailableUpdate?.sourceRevision != nextAvailableUpdate.sourceRevision {
        log("런타임 업데이트 가능: \(nextAvailableUpdate.displayRevision)")
      }
    } catch {
      lastRuntimeUpdateCheckError = error.localizedDescription
      log("런타임 업데이트 확인 실패: \(error.localizedDescription)")
    }
  }

  func recoverPendingLoginAfterRestart(log: @escaping @MainActor (String) -> Void) async {
    guard !pendingLoginRecoveryAttempted else {
      return
    }

    pendingLoginRecoveryAttempted = true
    ensureCodexHomeReady(log: log)

    guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path),
          let pendingLogin = loadPendingLogin(),
          !pendingLogin.loginId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }

    do {
      try await withCodexAppServerSession(log: log) { session in
        let status = try await session.readAccount(refreshToken: false)
        if status.loggedIn {
          self.clearPendingLogin()
          return ()
        }

        do {
          try await session.cancelLogin(loginId: pendingLogin.loginId)
          log("이전 로그인 시도를 정리했습니다.")
        } catch {
          log("이전 로그인 정리 중 오류가 있었지만 다시 로그인할 수 있도록 상태를 초기화합니다.")
        }

        self.clearPendingLogin()
        return ()
      }
    } catch {
      clearPendingLogin()
      log("이전 로그인 상태를 초기화했습니다.")
    }
  }

  func selectWorkspaceRoot() {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.prompt = "선택"
    panel.message = "local agent가 접근할 기본 워크스페이스 루트를 선택하세요."
    panel.directoryURL = URL(fileURLWithPath: configuration.workspaceRoots)

    if panel.runModal() == .OK, let url = panel.url {
      configuration.workspaceRoots = url.path
      saveConfiguration()
    }
  }

  func refreshDiagnostics() {
    let searchPaths = executableSearchPaths()
    let managedNodeExists = FileManager.default.isExecutableFile(atPath: runtimeNodeURL.path)
    let managedCodexExists = FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path)
    let activeRuntimeReleaseURL = currentRuntimeReleaseURL()
    let managedWorkspaceExists = activeRuntimeReleaseURL != nil
    let launchAgentExists = FileManager.default.fileExists(atPath: launchAgentURL.path)
    let bundleBootstrapExists = bundleBootstrapURL != nil

    diagnostics = [
      buildDiagnostic(
        title: "앱 런타임 워크스페이스",
        exists: managedWorkspaceExists,
        okDetail: activeRuntimeReleaseURL?.path ?? "",
        missingDetail: "아직 bootstrap 런타임이 스테이징되지 않았습니다."
      ),
      buildDiagnostic(
        title: "관리형 node",
        exists: managedNodeExists,
        okDetail: runtimeNodeURL.path,
        missingDetail: resolveExecutable(named: "node", searchPaths: searchPaths)?.path ?? "시스템 node 없음"
      ),
      buildDiagnostic(
        title: "관리형 codex",
        exists: managedCodexExists,
        okDetail: runtimeCodexURL.path,
        missingDetail: detectCodexSource()?.path ?? "시스템 codex 없음"
      ),
      buildDiagnostic(
        title: "bootstrap 리소스",
        exists: bundleBootstrapExists,
        okDetail: bundleBootstrapURL?.path ?? "",
        missingDetail: "앱 번들에 bootstrap 리소스가 없습니다."
      ),
      buildDiagnostic(
        title: "로그인 시 자동 실행",
        exists: launchAgentExists,
        okDetail: launchAgentURL.path,
        missingDetail: "LaunchAgent가 아직 설치되지 않았습니다."
      )
    ]

    if !requiresBootstrap {
      bootstrapSummary = "실행 준비됨"
    }
  }

  var requiresBootstrap: Bool {
    if !FileManager.default.isExecutableFile(atPath: runtimeNodeURL.path) {
      return true
    }

    if !FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) {
      return true
    }

    guard let activeRuntimeURL = currentRuntimeReleaseURL() else {
      return true
    }

    if !FileManager.default.fileExists(atPath: runtimeEnvURL.path) {
      return true
    }

    if !FileManager.default.fileExists(atPath: runtimeVersionURL.path) {
      return true
    }

    for requiredPath in requiredRuntimeWorkspacePaths(in: activeRuntimeURL) {
      if !FileManager.default.fileExists(atPath: requiredPath.path) {
        return true
      }
    }

    guard let buildInfo = loadRuntimeBuildInfo(at: activeRuntimeURL) else {
      return true
    }

    if buildInfo.appVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return true
    }

    if configuration.autoStartAtLogin && !FileManager.default.fileExists(atPath: launchAgentURL.path) {
      return true
    }

    return false
  }

  func makeLaunchContext() throws -> AgentLaunchContext {
    guard FileManager.default.isExecutableFile(atPath: runtimeNodeURL.path) else {
      throw AgentBootstrapError.nodeUnavailable
    }

    guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) else {
      throw AgentBootstrapError.codexUnavailable
    }

    guard let activeRuntimeURL = currentRuntimeReleaseURL(),
          FileManager.default.fileExists(atPath: activeRuntimeURL.path) else {
      throw AgentBootstrapError.bundleBootstrapUnavailable
    }

    ensureCodexHomeReady()

    return AgentLaunchContext(
      nodeExecutableURL: runtimeNodeURL,
      workspaceURL: activeRuntimeURL,
      environment: buildLaunchEnvironment()
    )
  }

  func ensureReadyForLaunch(log: @escaping @MainActor (String) -> Void) async -> Bool {
    if let bootstrapTask {
      return await bootstrapTask.value
    }

    ensureCodexHomeReady(log: log)
    await recoverPendingLoginAfterRestart(log: log)

    if !requiresBootstrap {
      let status = await currentCodexLoginStatus()
      codexLoggedIn = status.loggedIn
      codexLoginStatus = status.summary
      codexLoginStatusResolved = true
      if status.loggedIn {
        bootstrapSummary = "실행 준비됨"
        refreshDiagnostics()
        return true
      }

      bootstrapSummary = "Codex 로그인 필요"
      log("Codex 로그인이 필요해 환경 자동 설치를 다시 진행합니다.")
    }

    bootstrapSummary = "환경 자동 설치 실행 중"
    bootstrapInProgress = true

    let task = Task<Bool, Never> { @MainActor [weak self] in
      guard let self else { return false }
      defer {
        self.bootstrapInProgress = false
        self.bootstrapTask = nil
        self.refreshDiagnostics()
      }

      do {
      try await self.performBootstrap(log: log)
      let status = await self.currentCodexLoginStatus()
      self.codexLoggedIn = status.loggedIn
      self.codexLoginStatus = status.summary
      self.codexLoginStatusResolved = true
      self.bootstrapSummary = "환경 자동 설치 완료"
      self.lastBootstrapAt = Date()
      return true
      } catch {
        self.bootstrapSummary = "환경 자동 설치 실패: \(error.localizedDescription)"
        log("bootstrap 실패: \(error.localizedDescription)")
        return false
      }
    }

    bootstrapTask = task
    return await task.value
  }

  func runBootstrap(log: @escaping @MainActor (String) -> Void) {
    Task {
      _ = await ensureReadyForLaunch(log: log)
    }
  }

  func openRuntimeFolder() {
    NSWorkspace.shared.open(runtimeURL)
  }

  func prepareRuntimeReleaseForServiceStart(log: @escaping @MainActor (String) -> Void) async throws -> URL {
    try await ensureBaseEnvironmentReady(log: log)
    return try await prepareRuntimeCandidate(log: log)
  }

  @discardableResult
  func activateRuntimeRelease(_ releaseURL: URL, log: @escaping @MainActor (String) -> Void) throws -> URL? {
    let normalizedReleaseURL = releaseURL.standardizedFileURL
    let currentReleaseURL = currentRuntimeReleaseURL()?.standardizedFileURL

    guard currentReleaseURL != normalizedReleaseURL else {
      return currentReleaseURL
    }

    if let currentReleaseURL {
      try currentReleaseURL.path.write(
        to: runtimePreviousReleasePointerURL,
        atomically: true,
        encoding: .utf8)
    }

    try normalizedReleaseURL.path.write(
      to: runtimeCurrentReleasePointerURL,
      atomically: true,
      encoding: .utf8)

    log("활성 서비스 런타임을 전환했습니다. release=\(normalizedReleaseURL.lastPathComponent)")
    refreshDiagnostics()
    return currentReleaseURL
  }

  func rollbackRuntimeRelease(to releaseURL: URL, log: @escaping @MainActor (String) -> Void) throws {
    try releaseURL.standardizedFileURL.path.write(
      to: runtimeCurrentReleasePointerURL,
      atomically: true,
      encoding: .utf8)
    log("이전 서비스 런타임으로 롤백했습니다. release=\(releaseURL.lastPathComponent)")
    refreshDiagnostics()
  }

  func recordRuntimeHealthcheck(
    for releaseURL: URL,
    status: String,
    checks: [String],
    log: @escaping @MainActor (String) -> Void
  ) throws {
    let normalizedReleaseURL = releaseURL.standardizedFileURL
    let healthcheck = AgentRuntimeReleaseHealthcheck(
      status: status,
      checkedAt: Date(),
      checks: checks
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(healthcheck)
    try data.write(to: runtimeHealthcheckURL(for: normalizedReleaseURL), options: .atomic)
    log("서비스 런타임 상태를 기록했습니다. release=\(normalizedReleaseURL.lastPathComponent) status=\(status)")
  }

  func cleanupStaleRuntimeReleases(log: @escaping @MainActor (String) -> Void) throws {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: runtimeReleasesURL.path) else {
      return
    }

    let currentReleaseURL = currentRuntimeReleaseURL()?.standardizedFileURL
    let previousReleaseURL = previousRuntimeReleaseURL()?.standardizedFileURL
    let releaseURLs = try fileManager.contentsOfDirectory(
      at: runtimeReleasesURL,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ).filter {
      let name = $0.lastPathComponent
      return !name.hasPrefix(".staging-")
    }

    let sortedReleaseURLs = releaseURLs.sorted { left, right in
      let leftDate = (try? left.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      let rightDate = (try? right.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      return leftDate > rightDate
    }

    var preservedPaths = Set<String>()
    if let currentReleaseURL {
      preservedPaths.insert(currentReleaseURL.path)
    }
    if let previousReleaseURL {
      preservedPaths.insert(previousReleaseURL.path)
    }

    for releaseURL in sortedReleaseURLs.prefix(runtimeReleaseRetentionLimit) {
      preservedPaths.insert(releaseURL.standardizedFileURL.path)
    }

    var removedReleaseIDs: [String] = []
    for releaseURL in sortedReleaseURLs {
      guard !preservedPaths.contains(releaseURL.standardizedFileURL.path) else {
        continue
      }

      try fileManager.removeItem(at: releaseURL)
      removedReleaseIDs.append(releaseURL.lastPathComponent)
    }

    if !removedReleaseIDs.isEmpty {
      log("오래된 서비스 런타임 릴리즈를 정리했습니다. releases=\(removedReleaseIDs.joined(separator: ","))")
    }
  }

  private func ensureBaseEnvironmentReady(log: @escaping @MainActor (String) -> Void) async throws {
    try persistConfiguration()
    try ensureDirectory(appSupportURL)
    try ensureDirectory(runtimeURL)
    try ensureDirectory(runtimeReleasesURL)
    try ensureDirectory(runtimeBinURL)
    try ensureDirectory(codexHomeURL)
    try ensureDirectory(stateHomeURL)
    ensureCodexHomeReady(log: log)

    log("관리형 node를 준비합니다.")
    try await ensureManagedNode(log: log)

    log("codex 실행 파일을 준비합니다.")
    try await ensureManagedCodex(log: log)

    if currentRuntimeReleaseURL() == nil {
      let initialReleaseURL = try await prepareRuntimeCandidate(log: log)
      try activateRuntimeRelease(initialReleaseURL, log: log)
      try cleanupStaleRuntimeReleases(log: log)
    }

    log("Codex 로그인 상태를 확인합니다.")
    try await ensureCodexLogin(log: log)

    log("LaunchAgent를 설치합니다.")
    try installLaunchAgent(enabled: configuration.autoStartAtLogin, log: log)
  }

  private func prepareRuntimeCandidate(log: @escaping @MainActor (String) -> Void) async throws -> URL {
    try ensureDirectory(runtimeReleasesURL)
    let preparedSource = try await prepareRuntimeSource(log: log)
    defer {
      try? FileManager.default.removeItem(at: preparedSource.rootURL)
    }

    let sourceHash = try computeRuntimeSourceHash(from: preparedSource.rootURL)
    let sourceContentRevision = preparedSource.sourceContentRevision
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let configurationHash = try computeRuntimeConfigurationHash()
    let runtimeRevisionLabel = preparedSource.sourceRevision?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .prefix(12)
    let runtimeID = "runtime-\(runtimeRevisionLabel.map(String.init) ?? String(sourceContentRevision.prefix(12)))-\(String(configurationHash.prefix(12)))"
    let candidateReleaseURL = runtimeReleasesURL.appendingPathComponent(runtimeID, isDirectory: true)

    if let activeReleaseURL = currentRuntimeReleaseURL(),
       let buildInfo = loadRuntimeBuildInfo(at: activeReleaseURL),
       buildInfo.sourceHash == sourceHash,
       buildInfo.configurationHash == configurationHash {
      return activeReleaseURL
    }

    if isPreparedRuntimeRelease(at: candidateReleaseURL, sourceHash: sourceHash, configurationHash: configurationHash) {
      return candidateReleaseURL
    }

    let stagingURL = runtimeReleasesURL.appendingPathComponent(".staging-\(UUID().uuidString.lowercased())", isDirectory: true)
    if FileManager.default.fileExists(atPath: stagingURL.path) {
      try FileManager.default.removeItem(at: stagingURL)
    }

    log("새 서비스 런타임 후보를 준비합니다. release=\(runtimeID)")

    do {
      try copyDirectoryContents(from: preparedSource.rootURL, to: stagingURL)
      try writeRuntimeEnvironmentFile(to: stagingURL)
      try writeRuntimeVersion(to: stagingURL)
      try writeRuntimeBuildInfo(
        AgentRuntimeReleaseBuildInfo(
          runtimeID: runtimeID,
          sourceHash: sourceHash,
          configurationHash: configurationHash,
          sourceRevision: preparedSource.sourceRevision,
          sourceContentRevision: sourceContentRevision,
          appVersion: currentAppVersionTag,
          createdAt: Date()
        ),
        to: stagingURL
      )

      log("서비스 런타임 의존성을 설치합니다. release=\(runtimeID)")
      try await installRuntimeDependencies(in: stagingURL, log: log)
      try validatePreparedRuntimeRelease(
        at: stagingURL,
        sourceHash: sourceHash,
        configurationHash: configurationHash,
        log: log
      )

      if FileManager.default.fileExists(atPath: candidateReleaseURL.path) {
        try FileManager.default.removeItem(at: candidateReleaseURL)
      }

      try FileManager.default.moveItem(at: stagingURL, to: candidateReleaseURL)
      log("서비스 런타임 후보 준비가 완료되었습니다. release=\(runtimeID)")
      return candidateReleaseURL
    } catch {
      try? FileManager.default.removeItem(at: stagingURL)
      throw error
    }
  }

  private func prepareRuntimeSource(log: @escaping @MainActor (String) -> Void) async throws -> AgentPreparedRuntimeSource {
    guard let sourceURL = bundleBootstrapURL else {
      throw AgentBootstrapError.bundleBootstrapUnavailable
    }

    try ensureDirectory(runtimeSourceCacheURL)

    let stagingSourceURL = runtimeSourceCacheURL.appendingPathComponent(
      ".source-\(UUID().uuidString.lowercased())",
      isDirectory: true
    )

    if FileManager.default.fileExists(atPath: stagingSourceURL.path) {
      try FileManager.default.removeItem(at: stagingSourceURL)
    }

    try copyDirectoryContents(from: sourceURL, to: stagingSourceURL)

    if let preparedCodexAdapter = try await prepareLatestCodexAdapterSource(log: log) {
      let targetURL = stagingSourceURL.appendingPathComponent("services/codex-adapter", isDirectory: true)
      if FileManager.default.fileExists(atPath: targetURL.path) {
        try FileManager.default.removeItem(at: targetURL)
      }
      try copyDirectoryContents(from: preparedCodexAdapter.sourceURL, to: targetURL)

      if let sourceRevision = preparedCodexAdapter.sourceRevision,
         !sourceRevision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        log("최신 codex-adapter 소스를 반영합니다. revision=\(sourceRevision)")
      } else {
        log("최신 codex-adapter 소스를 반영합니다.")
      }

      return AgentPreparedRuntimeSource(
        rootURL: stagingSourceURL,
        sourceRevision: preparedCodexAdapter.sourceRevision,
        sourceContentRevision: preparedCodexAdapter.sourceContentRevision
      )
    }

    let bundledCodexAdapterURL = stagingSourceURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)
    let bundledContentRevision = try computeCodexAdapterContentRevision(from: bundledCodexAdapterURL)

    log("원격 codex-adapter 소스를 가져오지 못해 앱 번들 런타임을 사용합니다.")
    return AgentPreparedRuntimeSource(
      rootURL: stagingSourceURL,
      sourceRevision: nil,
      sourceContentRevision: bundledContentRevision
    )
  }

  private func prepareLatestCodexAdapterSource(
    log: @escaping @MainActor (String) -> Void
  ) async throws -> AgentPreparedCodexAdapterSource? {
    if let overrideURL = codexAdapterSourceOverrideURL() {
      let sourceContentRevision = try computeCodexAdapterContentRevision(from: overrideURL)
      let sourceRevision = gitRepositoryURL(containing: overrideURL)
        .flatMap { gitRevisionForPathIfAvailable(at: $0, path: overrideURL) }

      return AgentPreparedCodexAdapterSource(
        sourceURL: overrideURL,
        sourceRevision: sourceRevision,
        sourceContentRevision: sourceContentRevision
      )
    }

    guard let repositoryURL = try await ensureLatestCodexAdapterRepository(log: log) else {
      return nil
    }

    let codexAdapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)

    guard FileManager.default.fileExists(atPath: codexAdapterURL.appendingPathComponent("package.json").path) else {
      log("가져온 저장소에 codex-adapter가 없어 앱 번들 런타임을 사용합니다.")
      return nil
    }

    let sourceContentRevision = try computeCodexAdapterContentRevision(from: codexAdapterURL)
    let sourceRevision = gitRevisionForPathIfAvailable(
      at: repositoryURL,
      path: codexAdapterURL,
      remoteBranch: runtimeRepositoryBranch
    )

    return AgentPreparedCodexAdapterSource(
      sourceURL: codexAdapterURL,
      sourceRevision: sourceRevision,
      sourceContentRevision: sourceContentRevision
    )
  }

  private func resolveAvailableRuntimeUpdate() async throws -> RuntimeUpdateDescriptor? {
    if let runtimeUpdateRevisionResolver {
      guard let latestRevision = try await runtimeUpdateRevisionResolver(self)?
        .trimmingCharacters(in: .whitespacesAndNewlines),
        !latestRevision.isEmpty else {
        return nil
      }

      let currentRevision = currentRuntimeSourceRevision()?
        .trimmingCharacters(in: .whitespacesAndNewlines)

      if let currentRevision, !currentRevision.isEmpty, currentRevision == latestRevision {
        return nil
      }

      return RuntimeUpdateDescriptor(
        sourceRevision: latestRevision,
        currentSourceRevision: currentRevision
      )
    }

    guard let latestDescriptor = try await resolveLatestRuntimeSourceDescriptor() else {
      return nil
    }

    let currentRevision = currentRuntimeSourceRevision()?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let currentContentRevision = try currentRuntimeContentRevision()?
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if let currentContentRevision,
       !currentContentRevision.isEmpty,
       currentContentRevision == latestDescriptor.sourceContentRevision {
      return nil
    }

    return RuntimeUpdateDescriptor(
      sourceRevision: latestDescriptor.sourceRevision,
      currentSourceRevision: currentRevision,
      sourceContentRevision: latestDescriptor.sourceContentRevision,
      currentSourceContentRevision: currentContentRevision
    )
  }

  private func resolveLatestRuntimeSourceDescriptor() async throws -> RuntimeUpdateDescriptor? {
    if let overrideURL = codexAdapterSourceOverrideURL() {
      let sourceContentRevision = try computeCodexAdapterContentRevision(from: overrideURL)
      let sourceRevision = gitRepositoryURL(containing: overrideURL)
        .flatMap { gitRevisionForPathIfAvailable(at: $0, path: overrideURL) } ?? sourceContentRevision
      return RuntimeUpdateDescriptor(
        sourceRevision: sourceRevision,
        currentSourceRevision: nil,
        sourceContentRevision: sourceContentRevision,
        currentSourceContentRevision: nil
      )
    }

    guard let repositoryURL = try await ensureLatestCodexAdapterRepository(log: nil) else {
      return nil
    }

    let codexAdapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)

    guard FileManager.default.fileExists(atPath: codexAdapterURL.appendingPathComponent("package.json").path) else {
      return nil
    }

    let sourceContentRevision = try computeCodexAdapterContentRevision(from: codexAdapterURL)
    let sourceRevision = gitRevisionForPathIfAvailable(
      at: repositoryURL,
      path: codexAdapterURL,
      remoteBranch: runtimeRepositoryBranch
    ) ?? sourceContentRevision
    return RuntimeUpdateDescriptor(
      sourceRevision: sourceRevision,
      currentSourceRevision: nil,
      sourceContentRevision: sourceContentRevision,
      currentSourceContentRevision: nil
    )
  }

  private func currentRuntimeSourceRevision() -> String? {
    guard let activeRuntimeURL = currentRuntimeReleaseURL(),
          let buildInfo = loadRuntimeBuildInfo(at: activeRuntimeURL),
          let sourceRevision = buildInfo.sourceRevision?
            .trimmingCharacters(in: .whitespacesAndNewlines),
          !sourceRevision.isEmpty else {
      return nil
    }

    return sourceRevision
  }

  private func currentRuntimeContentRevision() throws -> String? {
    guard let activeRuntimeURL = currentRuntimeReleaseURL() else {
      return nil
    }

    let codexAdapterURL = activeRuntimeURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)

    guard FileManager.default.fileExists(atPath: codexAdapterURL.appendingPathComponent("package.json").path) else {
      return nil
    }

    return try computeCodexAdapterContentRevision(from: codexAdapterURL)
  }

  private func codexAdapterSourceOverrideURL() -> URL? {
    guard let overridePath = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !overridePath.isEmpty else {
      return nil
    }

    let baseURL = URL(fileURLWithPath: overridePath, isDirectory: true).standardizedFileURL
    let directPackageURL = baseURL.appendingPathComponent("package.json")
    if FileManager.default.fileExists(atPath: directPackageURL.path) {
      return baseURL
    }

    let nestedURL = baseURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)

    guard FileManager.default.fileExists(atPath: nestedURL.appendingPathComponent("package.json").path) else {
      return nil
    }

    return nestedURL
  }

  private func gitRevisionIfAvailable(at repositoryURL: URL) -> String? {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repositoryURL.path, "rev-parse", "HEAD"]
    process.standardOutput = output
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    guard process.terminationStatus == 0 else {
      return nil
    }

    let data = output.fileHandleForReading.readDataToEndOfFile()
    let value = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  private func gitRevisionForPathIfAvailable(
    at repositoryURL: URL,
    path targetURL: URL,
    remoteBranch: String? = nil
  ) -> String? {
    let repositoryPath = repositoryURL.standardizedFileURL.path
    let targetPath = targetURL.standardizedFileURL.path

    guard targetPath.hasPrefix(repositoryPath) else {
      return gitRevisionIfAvailable(at: repositoryURL)
    }

    let relativePath = String(targetPath.dropFirst(repositoryPath.count))
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let pathArgument = relativePath.isEmpty ? "." : relativePath

    if let remoteBranch,
       gitIsShallowRepository(at: repositoryURL) {
      _ = gitUnshallowRepository(at: repositoryURL, branch: remoteBranch)
    }

    return gitLoggedRevisionForPathIfAvailable(at: repositoryURL, pathArgument: pathArgument)
  }

  private func gitLoggedRevisionForPathIfAvailable(at repositoryURL: URL, pathArgument: String) -> String? {
    guard let result = runGitCommand(
      at: repositoryURL,
      arguments: ["log", "-1", "--format=%H", "--", pathArgument]
    ), result.status == 0 else {
      return nil
    }

    return result.output.isEmpty ? nil : result.output
  }

  private func gitIsShallowRepository(at repositoryURL: URL) -> Bool {
    guard let result = runGitCommand(
      at: repositoryURL,
      arguments: ["rev-parse", "--is-shallow-repository"]
    ), result.status == 0 else {
      return false
    }

    return result.output == "true"
  }

  private func gitUnshallowRepository(at repositoryURL: URL, branch: String) -> Bool {
    guard let result = runGitCommand(
      at: repositoryURL,
      arguments: ["fetch", "--unshallow", "origin", branch]
    ) else {
      return false
    }

    return result.status == 0
  }

  private func runGitCommand(at repositoryURL: URL, arguments: [String]) -> (status: Int32, output: String)? {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repositoryURL.path] + arguments
    process.standardOutput = output
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    let data = output.fileHandleForReading.readDataToEndOfFile()
    let value = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return (process.terminationStatus, value)
  }

  private func ensureLatestCodexAdapterRepository(
    log: (@MainActor (String) -> Void)?
  ) async throws -> URL? {
    try ensureDirectory(runtimeSourceCacheURL)
    let repositoryURL = runtimeRepositoryCacheURL
    let branch = runtimeRepositoryBranch

    if FileManager.default.fileExists(atPath: repositoryURL.appendingPathComponent(".git").path) {
      do {
        log?("codex-adapter 최신 소스를 가져옵니다. branch=\(branch)")
        try await runProcess(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: ["-C", repositoryURL.path, "fetch", "origin", branch],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log ?? { _ in }
        )
        try await runProcess(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: ["-C", repositoryURL.path, "reset", "--hard", "FETCH_HEAD"],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log ?? { _ in }
        )
      } catch {
        log?("codex-adapter 최신화에 실패해 마지막 캐시를 사용합니다: \(error.localizedDescription)")
      }
      return repositoryURL
    }

    do {
      log?("codex-adapter 소스 저장소를 초기화합니다.")
      try await runProcess(
        executableURL: URL(fileURLWithPath: "/usr/bin/git"),
        arguments: [
          "clone", "--depth", "1",
          "--branch", branch,
          runtimeRepositoryRemoteURL,
          repositoryURL.path
        ],
        environment: buildProcessEnvironment(),
        currentDirectoryURL: nil,
        log: log ?? { _ in }
      )
      return repositoryURL
    } catch {
      log?("codex-adapter 저장소 초기화에 실패했습니다: \(error.localizedDescription)")
      return nil
    }
  }

  private func gitRepositoryURL(containing url: URL) -> URL? {
    var candidate = url.standardizedFileURL

    while candidate.path != "/" {
      if FileManager.default.fileExists(atPath: candidate.appendingPathComponent(".git").path) {
        return candidate
      }

      let parent = candidate.deletingLastPathComponent()
      if parent.path == candidate.path {
        break
      }
      candidate = parent
    }

    return nil
  }

  private func currentRuntimeReleaseURL() -> URL? {
    guard FileManager.default.fileExists(atPath: runtimeCurrentReleasePointerURL.path),
          let rawValue = try? String(contentsOf: runtimeCurrentReleasePointerURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
          !rawValue.isEmpty else {
      return nil
    }

    let url = URL(fileURLWithPath: rawValue, isDirectory: true).standardizedFileURL
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }

    return url
  }

  private func previousRuntimeReleaseURL() -> URL? {
    guard FileManager.default.fileExists(atPath: runtimePreviousReleasePointerURL.path),
          let rawValue = try? String(contentsOf: runtimePreviousReleasePointerURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
          !rawValue.isEmpty else {
      return nil
    }

    let url = URL(fileURLWithPath: rawValue, isDirectory: true).standardizedFileURL
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }

    return url
  }

  private func runtimeBuildInfoURL(for releaseURL: URL) -> URL {
    releaseURL.appendingPathComponent("build-info.json")
  }

  private func runtimeHealthcheckURL(for releaseURL: URL) -> URL {
    releaseURL.appendingPathComponent("healthcheck.json")
  }

  private func writeRuntimeBuildInfo(_ buildInfo: AgentRuntimeReleaseBuildInfo, to releaseURL: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(buildInfo)
    try data.write(to: runtimeBuildInfoURL(for: releaseURL), options: .atomic)
  }

  private func loadRuntimeBuildInfo(at releaseURL: URL) -> AgentRuntimeReleaseBuildInfo? {
    guard let data = try? Data(contentsOf: runtimeBuildInfoURL(for: releaseURL)) else {
      return nil
    }

    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(AgentRuntimeReleaseBuildInfo.self, from: data)
  }

  private func isPreparedRuntimeRelease(at releaseURL: URL, sourceHash: String, configurationHash: String) -> Bool {
    guard FileManager.default.fileExists(atPath: releaseURL.path),
          let buildInfo = loadRuntimeBuildInfo(at: releaseURL),
          buildInfo.sourceHash == sourceHash,
          buildInfo.configurationHash == configurationHash else {
      return false
    }

    return requiredRuntimeValidationPaths(in: releaseURL).allSatisfy { FileManager.default.fileExists(atPath: $0.path) }
  }

  private func computeRuntimeSourceHash(from sourceURL: URL) throws -> String {
    try computeDirectoryContentHash(from: sourceURL)
  }

  private func computeCodexAdapterContentRevision(from sourceURL: URL) throws -> String {
    try computeDirectoryContentHash(
      from: sourceURL,
      excludingDirectoryNames: ["node_modules"],
      excludingFileNames: ["package-lock.json"]
    )
  }

  private func computeDirectoryContentHash(
    from sourceURL: URL,
    excludingDirectoryNames: Set<String> = [],
    excludingFileNames: Set<String> = []
  ) throws -> String {
    var fileURLs: [URL] = []
    try collectRuntimeSourceFiles(
      at: sourceURL,
      excludingDirectoryNames: excludingDirectoryNames,
      excludingFileNames: excludingFileNames,
      into: &fileURLs
    )

    let digest = SHA256.hash(data: fileURLs.reduce(into: Data()) { data, fileURL in
      let relativePath = fileURL.path.replacingOccurrences(of: sourceURL.path + "/", with: "")
      data.append(Data(relativePath.utf8))
      data.append(0)
      if let fileData = try? Data(contentsOf: fileURL) {
        data.append(fileData)
      }
      data.append(0)
    })

    return digest.map { String(format: "%02x", $0) }.joined()
  }

  private func collectRuntimeSourceFiles(
    at rootURL: URL,
    excludingDirectoryNames: Set<String> = [],
    excludingFileNames: Set<String> = [],
    into results: inout [URL]
  ) throws {
    let entries = try FileManager.default.contentsOfDirectory(
      at: rootURL,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ).sorted { $0.path < $1.path }

    for entry in entries {
      let isDirectory = (try entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
      if isDirectory {
        if excludingDirectoryNames.contains(entry.lastPathComponent) {
          continue
        }
        try collectRuntimeSourceFiles(
          at: entry,
          excludingDirectoryNames: excludingDirectoryNames,
          excludingFileNames: excludingFileNames,
          into: &results
        )
      } else {
        if excludingFileNames.contains(entry.lastPathComponent) {
          continue
        }
        results.append(entry)
      }
    }
  }

  private func computeRuntimeConfigurationHash() throws -> String {
    let envText = renderRuntimeEnvironmentText()
    let digest = SHA256.hash(data: Data(envText.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  private func performBootstrap(log: @escaping @MainActor (String) -> Void) async throws {
    try await ensureBaseEnvironmentReady(log: log)

    let latestReleaseURL = try await prepareRuntimeCandidate(log: log)
    try activateRuntimeRelease(latestReleaseURL, log: log)
    try cleanupStaleRuntimeReleases(log: log)
  }

  private func ensureManagedNode(log: @escaping @MainActor (String) -> Void) async throws {
    if FileManager.default.isExecutableFile(atPath: runtimeNodeURL.path) {
      log("관리형 node가 이미 존재합니다: \(runtimeNodeURL.path)")
      return
    }

    if let systemNode = resolveExecutable(named: "node", searchPaths: executableSearchPaths()) {
      log("시스템 node를 가져옵니다: \(systemNode.path)")
      try importNodePrefix(from: systemNode)
      return
    }

    log("시스템 node가 없어 Homebrew 설치를 시도합니다.")
    try await ensureHomebrewInstalled(log: log)
    try await runProcess(
      executableURL: URL(fileURLWithPath: "/bin/bash"),
      arguments: ["-lc", "brew install node"],
      environment: buildProcessEnvironment(),
      currentDirectoryURL: nil,
      log: log
    )

    guard let brewNode = resolveExecutable(named: "node", searchPaths: executableSearchPaths()) else {
      throw AgentBootstrapError.nodeUnavailable
    }

    try importNodePrefix(from: brewNode)
  }

  private func ensureManagedCodex(log: @escaping @MainActor (String) -> Void) async throws {
    if FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) {
      log("관리형 codex가 이미 존재합니다: \(runtimeCodexURL.path)")
      return
    }

    if let codexResource = detectCodexSource() {
      log("codex 실행 파일을 가져옵니다: \(codexResource.path)")
      try importCodexBinary(from: codexResource)
      return
    }

    log("시스템 codex가 없어 Homebrew cask 설치를 시도합니다.")
    try await ensureHomebrewInstalled(log: log)
    try await runProcess(
      executableURL: URL(fileURLWithPath: "/bin/bash"),
      arguments: ["-lc", "brew install --cask codex"],
      environment: buildProcessEnvironment(),
      currentDirectoryURL: nil,
      log: log
    )

    guard let installedCodex = detectCodexSource() else {
      throw AgentBootstrapError.codexUnavailable
    }

    try importCodexBinary(from: installedCodex)
  }

  private func installRuntimeDependencies(in runtimeReleaseURL: URL, log: @escaping @MainActor (String) -> Void) async throws {
    guard FileManager.default.fileExists(atPath: runtimeNpmCliURL.path) else {
      throw AgentBootstrapError.npmUnavailable
    }

    let packageURL = runtimeReleaseURL.appendingPathComponent("services/codex-adapter/package.json")
    guard FileManager.default.fileExists(atPath: packageURL.path) else {
      throw AgentBootstrapError.bundleBootstrapUnavailable
    }

    try await runProcess(
      executableURL: runtimeNodeURL,
      arguments: [runtimeNpmCliURL.path, "install", "--omit=dev"],
      environment: buildProcessEnvironment(),
      currentDirectoryURL: runtimeReleaseURL.appendingPathComponent("services/codex-adapter", isDirectory: true),
      log: log
    )
  }

  private func ensureCodexLogin(log: @escaping @MainActor (String) -> Void) async throws {
    let effectiveAuthMode = AgentBootstrapConfiguration.chatGptAuthMode
    if ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_SKIP_LOGIN_CHECKS"] == "1" {
      codexLoggedIn = true
      codexLoginStatus = "테스트 로그인 확인 건너뜀"
      codexLoginStatusResolved = true
      log("테스트 환경에서 Codex 로그인 확인을 건너뜁니다.")
      return
    }

    let status = await currentCodexLoginStatus()
    codexLoggedIn = status.loggedIn
    codexLoginStatus = status.summary
    codexLoginStatusResolved = true
    if status.loggedIn {
      log("Codex 로그인 상태를 재사용합니다.")
      return
    }

    if effectiveAuthMode == AgentBootstrapConfiguration.authModeApiKey {
      let savedApiKey = resolveApiKey(preferred: configuration.authApiKey)

      if savedApiKey?.isEmpty ?? true {
        log("API Key 방식은 설정 창에서 API Key를 입력해 로그인을 진행해 주세요.")
        codexLoggedIn = false
        codexLoginStatus = "API Key가 없습니다. 로그인 버튼에서 API Key를 입력하세요."
        codexLoginStatusResolved = true
        return
      }

      log("API Key 방식으로 로그인을 재시도합니다.")
      try await loginWithAuthSelection(log: log, authMode: configuration.authMode, apiKey: savedApiKey, logoutFirst: false)
      return
    }

    log("ChatGPT 로그인을 시작합니다.")
    try await loginWithAuthSelection(log: log, authMode: effectiveAuthMode, apiKey: nil, logoutFirst: false)
  }

  func reloginCodex(
    log: @escaping @MainActor (String) -> Void,
    authMode: String,
    apiKey: String?
  ) async {
    bootstrapInProgress = true
    codexLoginInProgress = true
    codexLoginStatusResolved = false
    bootstrapSummary = "Codex 계정 전환 중"

    do {
      try await loginWithAuthSelection(log: log, authMode: authMode, apiKey: apiKey, logoutFirst: true)
      bootstrapSummary = codexLoggedIn ? "Codex 계정 전환 완료" : "Codex 로그인 필요"
    } catch {
      bootstrapSummary = "Codex 계정 전환 실패: \(error.localizedDescription)"
      log("Codex 계정 전환 실패: \(error.localizedDescription)")
    }

    bootstrapInProgress = false
    codexLoginInProgress = false
    codexLoginStatusResolved = true
    refreshDiagnostics()
  }

  func loginCodex(
    log: @escaping @MainActor (String) -> Void,
    authMode: String,
    apiKey: String?
  ) async {
    bootstrapInProgress = true
    codexLoginInProgress = true
    codexLoginStatusResolved = false
    bootstrapSummary = "Codex 로그인 진행 중"

    do {
      try await loginWithAuthSelection(log: log, authMode: authMode, apiKey: apiKey, logoutFirst: false)
      bootstrapSummary = codexLoggedIn ? "Codex 로그인 완료" : "Codex 로그인 필요"
    } catch {
      bootstrapSummary = "Codex 로그인 실패: \(error.localizedDescription)"
      log("Codex 로그인 실패: \(error.localizedDescription)")
    }

    bootstrapInProgress = false
    codexLoginInProgress = false
    codexLoginStatusResolved = true
    refreshDiagnostics()
  }

  func handleCodexLoginAction(
    log: @escaping @MainActor (String) -> Void,
    authMode: String,
    apiKey: String?
  ) async {
    let normalizedAuthMode = AgentBootstrapConfiguration.chatGptAuthMode
    let trimmedApiKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    if normalizedAuthMode == AgentBootstrapConfiguration.authModeApiKey,
       !trimmedApiKey.isEmpty {
      if codexLoggedIn {
        await reloginCodex(log: log, authMode: authMode, apiKey: trimmedApiKey)
      } else {
        await loginCodex(log: log, authMode: authMode, apiKey: trimmedApiKey)
      }
      return
    }

    await refreshCodexLoginStatus()
    if codexLoggedIn {
      await reloginCodex(log: log, authMode: authMode, apiKey: apiKey)
    } else {
      await loginCodex(log: log, authMode: authMode, apiKey: apiKey)
    }
  }

  private func renderRuntimeEnvironmentText() -> String {
    let workspaceRoots = configuration.workspaceRoots
      .split(separator: ",")
      .map { NSString(string: String($0)).expandingTildeInPath.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: ",")

    return [
      "OCTOP_BRIDGE_OWNER_LOGIN_ID=\(configuration.ownerLoginId)",
      "OCTOP_BRIDGE_ID=\(resolveOrCreateBridgeId())",
      "OCTOP_BRIDGE_DEVICE_NAME=\(configuration.deviceName)",
      "OCTOP_WORKSPACE_ROOTS=\(workspaceRoots)",
      "OCTOP_NATS_URL=\(configuration.natsUrl)",
      "OCTOP_BRIDGE_HOST=\(configuration.bridgeHost)",
      "OCTOP_BRIDGE_PORT=\(configuration.bridgePort)",
      "OCTOP_BRIDGE_TOKEN=\(configuration.bridgeToken)",
      "OCTOP_APP_SERVER_MODE=\(configuration.appServerMode)",
      "OCTOP_APP_SERVER_WS_URL=\(configuration.appServerWsUrl)",
      "OCTOP_APP_SERVER_COMMAND=\(appServerCommand())",
      "OCTOP_CODEX_MODEL=\(configuration.codexModel)",
      "OCTOP_CODEX_REASONING_EFFORT=\(configuration.reasoningEffort)",
      "OCTOP_CODEX_APPROVAL_POLICY=\(configuration.approvalPolicy)",
      "OCTOP_CODEX_SANDBOX=\(configuration.sandboxMode)",
      "CODEX_HOME=\(codexHomeURL.path)",
      "OCTOP_STATE_HOME=\(stateHomeURL.path)",
      "OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS=\(configuration.watchdogIntervalMs)",
      "OCTOP_RUNNING_ISSUE_STALE_MS=\(configuration.staleMs)"
    ].joined(separator: "\n") + "\n"
  }

  private func writeRuntimeEnvironmentFile(to runtimeReleaseURL: URL) throws {
    try renderRuntimeEnvironmentText().write(
      to: runtimeReleaseURL.appendingPathComponent(".env.local"),
      atomically: true,
      encoding: .utf8
    )
  }

  private func writeRuntimeVersion(to runtimeReleaseURL: URL) throws {
    try currentAppVersionTag.write(
      to: runtimeReleaseURL.appendingPathComponent("version.txt"),
      atomically: true,
      encoding: .utf8
    )
  }

  private func installLaunchAgent(enabled: Bool, log: @escaping @MainActor (String) -> Void) throws {
    let bundlePath = Bundle.main.bundleURL.path
    try ensureDirectory(launchAgentURL.deletingLastPathComponent())

    let uid = String(getuid())
    let launchctlURL = URL(fileURLWithPath: "/bin/launchctl")
    let launchAgentPath = launchAgentURL.path

    if enabled {
      let plist = """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>app.diffcolor.octop.agentmenu.launcher</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/bin/open</string>
          <string>\(bundlePath)</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <false/>
        <key>LimitLoadToSessionType</key>
        <array>
          <string>Aqua</string>
        </array>
        <key>StandardOutPath</key>
        <string>\(NSHomeDirectory())/Library/Logs/OctOPAgentMenu.launcher.out.log</string>
        <key>StandardErrorPath</key>
        <string>\(NSHomeDirectory())/Library/Logs/OctOPAgentMenu.launcher.err.log</string>
      </dict>
      </plist>
      """

      try plist.write(to: launchAgentURL, atomically: true, encoding: .utf8)
      log("LaunchAgent를 현재 세션에 로드합니다.")
      Task {
        try? await runProcess(
          executableURL: launchctlURL,
          arguments: ["bootout", "gui/\(uid)", launchAgentPath],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
        try? await runProcess(
          executableURL: launchctlURL,
          arguments: ["bootstrap", "gui/\(uid)", launchAgentPath],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
      }
    } else {
      log("자동 실행이 꺼져 있어 LaunchAgent를 언로드합니다.")
      Task {
        try? await runProcess(
          executableURL: launchctlURL,
          arguments: ["bootout", "gui/\(uid)", launchAgentPath],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
        try? FileManager.default.removeItem(at: self.launchAgentURL)
      }
    }
  }

  private func importNodePrefix(from nodeExecutableURL: URL) throws {
    let prefixURL = nodeExecutableURL
      .deletingLastPathComponent()
      .deletingLastPathComponent()

    if FileManager.default.fileExists(atPath: runtimeNodePrefixURL.path) {
      try FileManager.default.removeItem(at: runtimeNodePrefixURL)
    }

    try FileManager.default.copyItem(at: prefixURL, to: runtimeNodePrefixURL)
  }

  private func importCodexBinary(from sourceURL: URL) throws {
    try ensureDirectory(runtimeBinURL)

    if FileManager.default.fileExists(atPath: runtimeCodexURL.path) {
      try FileManager.default.removeItem(at: runtimeCodexURL)
    }

    try FileManager.default.copyItem(at: sourceURL, to: runtimeCodexURL)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: runtimeCodexURL.path)

    let rgSource = sourceURL.deletingLastPathComponent().appendingPathComponent("rg")
    if FileManager.default.fileExists(atPath: rgSource.path) {
      if FileManager.default.fileExists(atPath: runtimeRgURL.path) {
        try FileManager.default.removeItem(at: runtimeRgURL)
      }

      try FileManager.default.copyItem(at: rgSource, to: runtimeRgURL)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: runtimeRgURL.path)
    }
  }

  private func ensureHomebrewInstalled(log: @escaping @MainActor (String) -> Void) async throws {
    if resolveExecutable(named: "brew", searchPaths: executableSearchPaths()) != nil {
      return
    }

    log("Homebrew 설치를 시작합니다.")
    try await runProcess(
      executableURL: URL(fileURLWithPath: "/bin/bash"),
      arguments: ["-lc", "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""],
      environment: buildProcessEnvironment().merging([
        "NONINTERACTIVE": "1",
        "CI": "1"
      ], uniquingKeysWith: { _, rhs in rhs }),
      currentDirectoryURL: nil,
      log: log
    )
  }

  private func runProcess(
    executableURL: URL,
    arguments: [String],
    environment: [String: String],
    currentDirectoryURL: URL?,
    log: @escaping @MainActor (String) -> Void,
    onOutputLine: (@Sendable (String) -> Void)? = nil
  ) async throws {
    try await withCheckedThrowingContinuation { continuation in
      let process = Process()
      let stdout = Pipe()
      let stderr = Pipe()
      let outputBuffer = ProcessOutputBuffer()

      process.executableURL = executableURL
      process.arguments = arguments
      process.environment = environment
      process.currentDirectoryURL = currentDirectoryURL
      process.standardOutput = stdout
      process.standardError = stderr

      let handler: @Sendable (FileHandle) -> Void = { handle in
        let data = handle.availableData
        guard !data.isEmpty else { return }
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline) {
          let logLine = String(line)
          outputBuffer.append(logLine)
          onOutputLine?(logLine)
          Task { @MainActor in
            log(logLine)
          }
        }
      }

      stdout.fileHandleForReading.readabilityHandler = handler
      stderr.fileHandleForReading.readabilityHandler = handler

      process.terminationHandler = { process in
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil

        if process.terminationReason == .exit, process.terminationStatus == 0 {
          continuation.resume()
        } else {
          let summary = outputBuffer.joinedSummary()
          continuation.resume(throwing: NSError(
            domain: "OctOPAgentMenu.Process",
            code: Int(process.terminationStatus),
            userInfo: [
              NSLocalizedDescriptionKey: summary.isEmpty
                ? "명령 실행 실패: \(executableURL.lastPathComponent) \(arguments.joined(separator: " "))"
                : summary
            ]))
        }
      }

      do {
        try process.run()
      } catch {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        continuation.resume(throwing: error)
      }
    }
  }

  private func copyDirectoryContents(from sourceURL: URL, to destinationURL: URL) throws {
    try ensureDirectory(destinationURL)
    let fileManager = FileManager.default
    let entries = try fileManager.contentsOfDirectory(at: sourceURL, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])

    for entry in entries {
      let target = destinationURL.appendingPathComponent(entry.lastPathComponent, isDirectory: false)
      let isDirectory = (try entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false

      if isDirectory {
        try copyDirectoryContents(from: entry, to: target)
      } else {
        if fileManager.fileExists(atPath: target.path) {
          try fileManager.removeItem(at: target)
        }

        try fileManager.copyItem(at: entry, to: target)
      }
    }
  }

  private func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  private func resolveOrCreateBridgeId() -> String {
    if let derived = resolveStableBridgeId() {
      try? persistBridgeId(derived)
      return derived
    }

    for candidate in [bridgeIdURL, legacyBridgeIdURL] {
      if let value = try? String(contentsOf: candidate, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines),
         !value.isEmpty {
        try? persistBridgeId(value)
        return value
      }
    }

    let fallbackSource = "\(ProcessInfo.processInfo.hostName)|\(ProcessInfo.processInfo.operatingSystemVersionString)"
    let fallback = "bridge-\(computeSha256HexUpper(fallbackSource).lowercased())"
    try? persistBridgeId(fallback)
    return fallback
  }

  private func resolveStableBridgeId() -> String? {
    let normalized = Array(Set(collectMacFingerprintSources().map(normalizeFingerprintValue).filter { !$0.isEmpty })).sorted()

    guard !normalized.isEmpty else {
      return nil
    }

    return "bridge-\(computeSha256HexUpper(normalized.joined(separator: "|")).lowercased())"
  }

  private func collectMacFingerprintSources() -> [String] {
    let ioRegOutput = runCommand("/usr/sbin/ioreg", arguments: ["-rd1", "-c", "IOPlatformExpertDevice"])
    let systemProfilerOutput = runCommand("/usr/sbin/system_profiler", arguments: ["SPHardwareDataType"])

    return [
      extractQuotedValue(ioRegOutput, key: "IOPlatformUUID"),
      extractQuotedValue(ioRegOutput, key: "IOPlatformSerialNumber"),
      extractColonValue(systemProfilerOutput, key: "Hardware UUID"),
      extractColonValue(systemProfilerOutput, key: "Serial Number (system)")
    ]
  }

  private func runCommand(_ launchPath: String, arguments: [String]) -> String {
    let process = Process()
    let outputPipe = Pipe()
    let errorPipe = Pipe()

    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    process.standardOutput = outputPipe
    process.standardError = errorPipe

    do {
      try process.run()
      process.waitUntilExit()
      let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
      return String(data: data, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    } catch {
      return ""
    }
  }

  private func extractQuotedValue(_ text: String, key: String) -> String {
    let pattern = "\"\(NSRegularExpression.escapedPattern(for: key))\"\\s*=\\s*\"([^\"]+)\""
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let valueRange = Range(match.range(at: 1), in: text) else {
      return ""
    }

    return String(text[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func extractColonValue(_ text: String, key: String) -> String {
    for line in text.split(whereSeparator: \.isNewline) {
      let rawLine = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
      guard rawLine.lowercased().hasPrefix("\(key.lowercased()):") else {
        continue
      }

      return rawLine.split(separator: ":", maxSplits: 1).dropFirst().first?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    return ""
  }

  private func normalizeFingerprintValue(_ value: String) -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    guard !normalized.isEmpty else {
      return ""
    }

    let dummyValues: Set<String> = [
      "",
      "0",
      "00",
      "000",
      "0000",
      "00000000",
      "unknown",
      "none",
      "default",
      "n/a",
      "android",
      "alps",
      "generic",
      "goldfish",
      "default string"
    ]

    if dummyValues.contains(normalized) || normalized.allSatisfy({ $0 == "0" }) {
      return ""
    }

    return normalized
  }

  private func computeSha256HexUpper(_ source: String) -> String {
    SHA256.hash(data: Data(source.utf8))
      .map { String(format: "%02X", $0) }
      .joined()
  }

  private func persistBridgeId(_ bridgeId: String) throws {
    try ensureDirectory(appSupportURL)
    try ensureDirectory(stateHomeURL)
    try bridgeId.write(to: bridgeIdURL, atomically: true, encoding: .utf8)
    try bridgeId.write(to: legacyBridgeIdURL, atomically: true, encoding: .utf8)
  }

  private func persistConfiguration() throws {
    try ensureDirectory(appSupportURL)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    var sanitizedConfiguration = configuration
    sanitizedConfiguration.authApiKey = ""
    let data = try encoder.encode(sanitizedConfiguration)
    try data.write(to: configurationURL, options: .atomic)
  }

  private func persistApiKeyInputIfNeeded() throws {
    let trimmedApiKey = authApiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard configuration.authMode == AgentBootstrapConfiguration.authModeApiKey,
          !trimmedApiKey.isEmpty else {
      return
    }

    try AgentMenuKeychain.save(trimmedApiKey, account: AgentMenuKeychain.codexApiKeyAccount)
    configuration.authApiKey = ""
  }

  private func storedApiKey() -> String? {
    let keychainValue = try? AgentMenuKeychain.read(account: AgentMenuKeychain.codexApiKeyAccount)
    let trimmedKeychainValue = keychainValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedKeychainValue.isEmpty {
      return trimmedKeychainValue
    }

    let legacyValue = configuration.authApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    return legacyValue.isEmpty ? nil : legacyValue
  }

  private func resolveApiKey(preferred explicitValue: String?) -> String? {
    let trimmedExplicitValue = explicitValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedExplicitValue.isEmpty {
      return trimmedExplicitValue
    }

    let trimmedInputValue = authApiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedInputValue.isEmpty {
      return trimmedInputValue
    }

    return storedApiKey()
  }

  private func migrateLegacyApiKeyIfNeeded() {
    let legacyValue = configuration.authApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !legacyValue.isEmpty else {
      configuration.authApiKey = ""
      return
    }

    do {
      try AgentMenuKeychain.save(legacyValue, account: AgentMenuKeychain.codexApiKeyAccount)
      configuration.authApiKey = ""
      try? persistConfiguration()
    } catch {
      bootstrapSummary = "API Key 이전 실패: \(error.localizedDescription)"
    }
  }

  private func validateOpenAIApiKey(_ apiKey: String) async -> (valid: Bool, summary: String) {
    guard let url = URL(string: "https://api.openai.com/v1/models") else {
      return (false, "API Key 검증 URL이 잘못되었습니다.")
    }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 20
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let httpResponse = response as? HTTPURLResponse else {
        return (false, "API Key 검증 응답을 해석하지 못했습니다.")
      }

      if (200..<300).contains(httpResponse.statusCode) {
        return (true, "API Key 로그인됨")
      }

      if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let error = json["error"] as? [String: Any],
         let message = error["message"] as? String,
         !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return (false, message)
      }

      return (false, "API Key 검증 실패 (\(httpResponse.statusCode))")
    } catch {
      return (false, "API Key 검증 실패: \(error.localizedDescription)")
    }
  }

  private func buildProcessEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = executableSearchPaths().joined(separator: ":")
    return environment
  }

  private func buildLaunchEnvironment(extra: [String: String] = [:]) -> [String: String] {
    var environment = buildProcessEnvironment()
    environment["PATH"] = [
      runtimeNodePrefixURL.appendingPathComponent("bin").path,
      runtimeBinURL.path,
      environment["PATH"] ?? ""
    ].filter { !$0.isEmpty }.joined(separator: ":")

    let values: [String: String] = [
      "OCTOP_BRIDGE_OWNER_LOGIN_ID": configuration.ownerLoginId,
      "OCTOP_BRIDGE_ID": resolveOrCreateBridgeId(),
      "OCTOP_BRIDGE_DEVICE_NAME": configuration.deviceName,
      "OCTOP_WORKSPACE_ROOTS": configuration.workspaceRoots,
      "OCTOP_NATS_URL": configuration.natsUrl,
      "OCTOP_BRIDGE_HOST": configuration.bridgeHost,
      "OCTOP_BRIDGE_PORT": configuration.bridgePort,
      "OCTOP_BRIDGE_TOKEN": configuration.bridgeToken,
      "OCTOP_APP_SERVER_MODE": configuration.appServerMode,
      "OCTOP_APP_SERVER_WS_URL": configuration.appServerWsUrl,
      "OCTOP_APP_SERVER_COMMAND": appServerCommand(),
      "OCTOP_CODEX_MODEL": configuration.codexModel,
      "OCTOP_CODEX_REASONING_EFFORT": configuration.reasoningEffort,
      "OCTOP_CODEX_APPROVAL_POLICY": configuration.approvalPolicy,
      "OCTOP_CODEX_SANDBOX": configuration.sandboxMode,
      "CODEX_HOME": codexHomeURL.path,
      "OCTOP_STATE_HOME": stateHomeURL.path,
      "OCTOP_RUNNING_ISSUE_WATCHDOG_INTERVAL_MS": configuration.watchdogIntervalMs,
      "OCTOP_RUNNING_ISSUE_STALE_MS": configuration.staleMs
    ]

    for (key, value) in values where !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      environment[key] = value
    }

    for (key, value) in extra where !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      environment[key] = value
    }

    return environment
  }

  private func shouldDangerouslyBypassApprovalsAndSandbox() -> Bool {
    configuration.sandboxMode.trimmingCharacters(in: .whitespacesAndNewlines) ==
      AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox
  }

  private func appServerCommand() -> String {
    let bypassArgument = shouldDangerouslyBypassApprovalsAndSandbox()
      ? " --dangerously-bypass-approvals-and-sandbox"
      : ""
    return "\(shellEscape(runtimeCodexURL.path))\(bypassArgument) app-server --listen \(shellEscape(configuration.appServerWsUrl))"
  }

  private func withCodexAppServerSession<T: Sendable>(
    log: (@MainActor (String) -> Void)? = nil,
    operation: @escaping (CodexAppServerSession) async throws -> T
  ) async throws -> T {
    let session = try CodexAppServerSession(
      executableURL: runtimeCodexURL,
      environment: buildLaunchEnvironment(),
      currentDirectoryURL: currentRuntimeReleaseURL() ?? appSupportURL,
      log: { line in
        guard let log else { return }
        Task { @MainActor in
          log(line)
        }
      }
    )

    do {
      try await session.initialize()
      let result = try await operation(session)
      await session.shutdown()
      return result
    } catch {
      await session.shutdown()
      throw error
    }
  }

  private func shellEscape(_ value: String) -> String {
    let text = value.trimmingCharacters(in: .newlines)
    guard !text.isEmpty else {
      return "''"
    }

    return "'\(text.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }

  private func currentCodexLoginStatus() async -> (loggedIn: Bool, summary: String) {
    let effectiveAuthMode = AgentBootstrapConfiguration.chatGptAuthMode
    if effectiveAuthMode == AgentBootstrapConfiguration.authModeApiKey {
      guard let apiKey = resolveApiKey(preferred: nil), !apiKey.isEmpty else {
        return (false, "저장된 API Key가 없습니다.")
      }

      let validation = await validateOpenAIApiKey(apiKey)
      guard validation.valid else {
        return (false, validation.summary)
      }

      guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) else {
        return (false, "Codex 미설치")
      }

      do {
        return try await withCodexAppServerSession { session in
          let status = try await session.readAccount(refreshToken: false)
          if status.loggedIn && status.accountType == "apiKey" {
            return (true, "API Key 로그인됨")
          }

          return (false, "API Key 확인됨. 로그인 버튼을 눌러 연결하세요.")
        }
      } catch is CancellationError {
        return (codexLoggedIn, codexLoginStatus)
      } catch {
        let summary = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return (false, summary)
      }
    }

    if let localStatus = localCodexAuthStoreStatus(at: codexHomeURL) {
      return (localStatus.loggedIn, localStatus.summary)
    }

    guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) else {
      return (false, "Codex 미설치")
    }

    do {
      return try await withCodexAppServerSession { session in
        let status = try await session.readAccount(refreshToken: false)
        return (status.loggedIn, status.summary)
      }
    } catch is CancellationError {
      return (codexLoggedIn, codexLoginStatus)
    } catch {
      let summary = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
      return (false, summary)
    }
  }

  private func loginWithAuthSelection(
    log: @escaping @MainActor (String) -> Void,
    authMode: String,
    apiKey: String?,
    logoutFirst: Bool
  ) async throws {
    let selectedAuthMode = AgentBootstrapConfiguration.normalizedAuthMode(authMode)

    if selectedAuthMode == AgentBootstrapConfiguration.authModeApiKey {
      let trimmedApiKey = resolveApiKey(preferred: apiKey) ?? ""
      if trimmedApiKey.isEmpty {
        throw NSError(
          domain: "OctOPAgentMenu.Login",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "API Key가 비어 있습니다."]
        )
      }

      let validation = await validateOpenAIApiKey(trimmedApiKey)
      guard validation.valid else {
        codexLoggedIn = false
        codexLoginStatus = validation.summary
        codexLoginStatusResolved = true
        throw NSError(
          domain: "OctOPAgentMenu.Login",
          code: 4,
          userInfo: [NSLocalizedDescriptionKey: validation.summary]
        )
      }

      log("API Key로 로그인을 시작합니다.")
      AgentLoginDebugLog.write("apiKey selected")
      let accountStatus = try await runCodexLoginHelper(
        authMode: selectedAuthMode,
        apiKey: trimmedApiKey,
        browserID: nil,
        logoutFirst: logoutFirst,
        log: log
      )
      if accountStatus.loggedIn {
        try persistApiKeyInputIfNeeded()
        authApiKeyInput = ""
      }
      codexLoggedIn = accountStatus.loggedIn
      codexLoginStatus = accountStatus.loggedIn ? "API Key 로그인됨" : accountStatus.summary
      codexLoginStatusResolved = true
      return
    }

    guard let browserID = await CodexBrowserSelection.selectBrowserID() else {
      AgentLoginDebugLog.write("browser selection cancelled")
      throw NSError(
        domain: "OctOPAgentMenu.Browser",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "로그인에 사용할 브라우저 선택이 취소되었습니다."]
      )
    }

    log("선택한 브라우저로 로그인을 시작합니다.")
    AgentLoginDebugLog.write("browser selected: \(browserID)")

    let accountStatus = try await runCodexLoginHelper(
      authMode: selectedAuthMode,
      apiKey: nil,
      browserID: browserID,
      logoutFirst: logoutFirst,
      log: log
    )

    AgentLoginDebugLog.write("account read after login: summary=\(accountStatus.summary)")
    codexLoggedIn = accountStatus.loggedIn
    codexLoginStatus = accountStatus.summary
    codexLoginStatusResolved = true
  }

  private func logoutCodex(log: @escaping @MainActor (String) -> Void) async throws {
    guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) else {
      log("Codex CLI가 아직 준비되지 않아 로그아웃을 건너뜁니다.")
      return
    }

    try await withCodexAppServerSession(log: log) { session in
      try await session.logout()
      self.clearPendingLogin()
      return ()
    }
  }

  private func loadPendingLogin() -> PendingLoginState? {
    guard FileManager.default.fileExists(atPath: pendingLoginURL.path),
          let data = try? Data(contentsOf: pendingLoginURL) else {
      return nil
    }

    return try? JSONDecoder().decode(PendingLoginState.self, from: data)
  }

  private func savePendingLogin(loginId: String) throws {
    try ensureDirectory(appSupportURL)
    let data = try JSONEncoder().encode(PendingLoginState(loginId: loginId, startedAt: Date()))
    try data.write(to: pendingLoginURL, options: .atomic)
  }

  private func clearPendingLogin() {
    try? FileManager.default.removeItem(at: pendingLoginURL)
  }

  private func runCodexLoginHelper(
    authMode: String,
    apiKey: String?,
    browserID: String?,
    logoutFirst: Bool,
    log: @escaping @MainActor (String) -> Void
  ) async throws -> BrowserLoginHelperResult {
    let scriptURL = runtimeWorkspaceURL.appendingPathComponent("scripts/login-via-app-server.mjs")
    guard FileManager.default.isExecutableFile(atPath: runtimeNodeURL.path) else {
      throw AgentBootstrapError.nodeUnavailable
    }

    guard FileManager.default.fileExists(atPath: scriptURL.path) else {
      throw NSError(
        domain: "OctOPAgentMenu.Login",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "로그인 도우미 스크립트를 찾지 못했습니다: \(scriptURL.path)"]
      )
    }

    return try await withCheckedThrowingContinuation { continuation in
      let process = Process()
      let stdout = Pipe()
      let stderr = Pipe()
      let outputBuffer = ProcessOutputBuffer()
      let helperState = BrowserLoginHelperState()
      let pendingLoginURL = self.pendingLoginURL
      let applicationSupportURL = self.appSupportURL

      let resumeOnce: @Sendable (Result<BrowserLoginHelperResult, Error>) -> Void = { outcome in
        guard helperState.markFinished() else {
          return
        }

        continuation.resume(with: outcome)
      }

      let savePendingLogin: @Sendable (String) -> Void = { loginId in
        guard !loginId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
          return
        }

        do {
          try FileManager.default.createDirectory(at: applicationSupportURL, withIntermediateDirectories: true)
          let data = try JSONEncoder().encode(PendingLoginState(loginId: loginId, startedAt: Date()))
          try data.write(to: pendingLoginURL, options: .atomic)
        } catch {
          AgentLoginDebugLog.write("save pending login failed: \(error.localizedDescription)")
        }
      }

      let clearPendingLogin: @Sendable () -> Void = {
        try? FileManager.default.removeItem(at: pendingLoginURL)
      }

      let postLog: @Sendable (String) -> Void = { message in
        Task { @MainActor in
          log(message)
        }
      }

      let handleStructuredLine: @Sendable (String) -> Void = { line in
        guard let data = line.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = raw["event"] as? String else {
          outputBuffer.append(line)
          postLog(line)
          return
        }

        switch event {
        case "logout":
          AgentLoginDebugLog.write("logout before relogin start")
          postLog("현재 Codex 로그인 계정을 로그아웃합니다.")
          clearPendingLogin()
        case "loginStart":
          let loginId = raw["loginId"] as? String ?? ""
          let authUrl = raw["authUrl"] as? String ?? ""
          let keyLength = raw["keyLength"] as? Int ?? 0
          let keyFingerprint = raw["keyFingerprint"] as? String ?? ""
          let keyFingerprintLog = keyFingerprint.isEmpty ? "none" : keyFingerprint
          AgentLoginDebugLog.write("loginStart: loginId=\(loginId), keyFingerprint=\(keyFingerprintLog), keyLength=\(keyLength), authUrl=\(authUrl)")
          if let loginIdToSave = raw["loginId"] as? String, !loginIdToSave.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            savePendingLogin(loginIdToSave)
          }
          postLog("로그인 URL 생성: \(authUrl)")
          if let browserID {
            postLog("선택한 브라우저 번들 ID: \(browserID)")
          }
        case "loginCompleted":
          let loginId = raw["loginId"] as? String ?? ""
          let success = raw["success"] as? Bool ?? false
          let error = raw["error"] as? String ?? ""
          AgentLoginDebugLog.write("loginCompleted: loginId=\(loginId), success=\(success), error=\(error)")
        case "browserOpened":
          if let browserID {
            AgentLoginDebugLog.write("browser open exit: bundle=\(browserID) status=0")
          }
          postLog("선택한 브라우저를 열었습니다.")
        case "waitingForCompletion":
          let loginId = raw["loginId"] as? String ?? ""
          AgentLoginDebugLog.write("waiting for login completion: loginId=\(loginId)")
          postLog("브라우저에서 인증을 완료해 주세요.")
        case "loginComplete":
          let loggedIn = raw["loggedIn"] as? Bool ?? false
          let summary = raw["summary"] as? String ?? "로그인됨"
          helperState.setResult(BrowserLoginHelperResult(loggedIn: loggedIn, summary: summary))
          AgentLoginDebugLog.write("login completion received: summary=\(summary)")
          clearPendingLogin()
        case "accountRead":
          let loggedIn = raw["loggedIn"] as? Bool ?? false
          let requiresOpenAiAuth = raw["requiresOpenAiAuth"] as? Bool ?? false
          let accountType = raw["accountType"] as? String
          let hasEmail = raw["hasEmail"] as? Bool ?? false
          AgentLoginDebugLog.write("account/read: loggedIn=\(loggedIn), requiresOpenAiAuth=\(requiresOpenAiAuth), accountType=\(accountType ?? "unknown"), hasEmail=\(hasEmail)")
        case "stderr":
          let message = raw["message"] as? String ?? ""
          outputBuffer.append(message)
          postLog(message)
        case "error":
          let message = raw["message"] as? String ?? "로그인 처리 중 오류가 발생했습니다."
          outputBuffer.append(message)
          AgentLoginDebugLog.write("login helper error: \(message)")
        default:
          break
        }
      }

      process.executableURL = runtimeNodeURL
      var arguments = [
        scriptURL.path,
        "--codex", runtimeCodexURL.path,
        "--auth-mode", authMode
      ]
      if let browserID {
        arguments.append(contentsOf: ["--browser-bundle-id", browserID])
      }
      if let apiKey {
        arguments.append(contentsOf: ["--api-key", apiKey])
      }
      if logoutFirst {
        arguments.append("--logout-first")
      }
      process.arguments = arguments
      process.environment = buildLaunchEnvironment()
      process.currentDirectoryURL = runtimeWorkspaceURL
      process.standardOutput = stdout
      process.standardError = stderr

      let stdoutHandler: @Sendable (FileHandle) -> Void = { handle in
        let data = handle.availableData
        guard !data.isEmpty else { return }
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline) {
          handleStructuredLine(String(line))
        }
      }

      let stderrHandler: @Sendable (FileHandle) -> Void = { handle in
        let data = handle.availableData
        guard !data.isEmpty else { return }
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline) {
          let logLine = String(line)
          outputBuffer.append(logLine)
          AgentLoginDebugLog.write("login helper stderr: \(logLine)")
          Task { @MainActor in
            log(logLine)
          }
        }
      }

      stdout.fileHandleForReading.readabilityHandler = stdoutHandler
      stderr.fileHandleForReading.readabilityHandler = stderrHandler

      process.terminationHandler = { process in
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil

        if process.terminationReason == .exit, process.terminationStatus == 0 {
          resumeOnce(.success(helperState.snapshot()))
          return
        }

        let summary = outputBuffer.joinedSummary()
        let description = summary.isEmpty
          ? "로그인 도우미 실행 실패 (exit=\(process.terminationStatus))"
          : summary
        resumeOnce(.failure(NSError(
          domain: "OctOPAgentMenu.Login",
          code: Int(process.terminationStatus),
          userInfo: [NSLocalizedDescriptionKey: description]
        )))
      }

      do {
        let browserInfo = browserID ?? "none"
        AgentLoginDebugLog.write("login helper process start: browser=\(browserInfo)")
        try process.run()
      } catch {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        resumeOnce(.failure(error))
      }
    }
  }

  private var bundleBootstrapURL: URL? {
    if let overridePath = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_BOOTSTRAP_PATH"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overridePath.isEmpty {
      return URL(fileURLWithPath: overridePath, isDirectory: true).standardizedFileURL
    }

    return Bundle.module.resourceURL?.appendingPathComponent("bootstrap", isDirectory: true)
  }

  private func detectCodexSource() -> URL? {
    let candidates = [
      "/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex"
    ]

    for path in candidates {
      if FileManager.default.isExecutableFile(atPath: path) {
        return URL(fileURLWithPath: path).resolvingSymlinksInPath()
      }
    }

    return resolveExecutable(named: "codex", searchPaths: executableSearchPaths())
  }

  private func requiredRuntimeWorkspacePaths(in runtimeReleaseURL: URL) -> [URL] {
    [
      runtimeReleaseURL.appendingPathComponent("scripts/run-local-agent.mjs"),
      runtimeReleaseURL.appendingPathComponent("scripts/run-bridge.mjs"),
      runtimeReleaseURL.appendingPathComponent("scripts/shared-env.mjs"),
      runtimeReleaseURL.appendingPathComponent("scripts/login-via-app-server.mjs"),
      runtimeReleaseURL.appendingPathComponent("services/codex-adapter/package.json"),
      runtimeReleaseURL.appendingPathComponent("services/codex-adapter/src/index.js"),
      runtimeReleaseURL.appendingPathComponent("services/codex-adapter/src/domain.js")
    ]
  }

  private func requiredRuntimeValidationPaths(in runtimeReleaseURL: URL) -> [URL] {
    requiredRuntimeWorkspacePaths(in: runtimeReleaseURL) + [
      runtimeReleaseURL.appendingPathComponent(".env.local"),
      runtimeReleaseURL.appendingPathComponent("version.txt"),
      runtimeReleaseURL.appendingPathComponent("build-info.json"),
      runtimeReleaseURL.appendingPathComponent("services/codex-adapter/package-lock.json")
    ]
  }

  private func validatePreparedRuntimeRelease(
    at releaseURL: URL,
    sourceHash: String,
    configurationHash: String,
    log: @escaping @MainActor (String) -> Void
  ) throws {
    let requiredPaths = requiredRuntimeValidationPaths(in: releaseURL)
    let missingPaths = requiredPaths.filter { !FileManager.default.fileExists(atPath: $0.path) }

    guard missingPaths.isEmpty else {
      let labels = missingPaths.map(\.lastPathComponent).joined(separator: ", ")
      throw NSError(
        domain: "OctOPAgentMenu.Runtime",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "서비스 런타임 검증 실패: 필수 파일 누락 (\(labels))"]
      )
    }

    guard let buildInfo = loadRuntimeBuildInfo(at: releaseURL),
          buildInfo.sourceHash == sourceHash,
          buildInfo.configurationHash == configurationHash else {
      throw NSError(
        domain: "OctOPAgentMenu.Runtime",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "서비스 런타임 검증 실패: build-info.json 내용이 예상과 다릅니다."]
      )
    }

    let checks = [
      "필수 엔트리 확인 완료",
      "codex-adapter 의존성 설치 확인 완료",
      "런타임 환경 파일 생성 확인 완료",
      "버전 메타데이터 생성 확인 완료"
    ]
    try recordRuntimeHealthcheck(for: releaseURL, status: "prepared", checks: checks, log: log)
  }

  private func executableSearchPaths() -> [String] {
    var paths = [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      NSString(string: "~/.local/bin").expandingTildeInPath,
      NSString(string: "~/.bun/bin").expandingTildeInPath,
      NSString(string: "~/.volta/bin").expandingTildeInPath,
      NSString(string: "~/.nodenv/shims").expandingTildeInPath,
      NSString(string: "~/.asdf/shims").expandingTildeInPath,
      NSString(string: "~/.cargo/bin").expandingTildeInPath
    ]

    if let currentPath = ProcessInfo.processInfo.environment["PATH"] {
      paths = currentPath.split(separator: ":").map(String.init) + paths
    }

    let nvmRoot = URL(fileURLWithPath: NSString(string: "~/.nvm/versions/node").expandingTildeInPath, isDirectory: true)
    if let entries = try? FileManager.default.contentsOfDirectory(at: nvmRoot, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) {
      for entry in entries.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) {
        let isDirectory = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
        if isDirectory {
          paths.append(entry.appendingPathComponent("bin", isDirectory: true).path)
        }
      }
    }

    var seen = Set<String>()
    return paths.filter {
      let normalized = NSString(string: $0).expandingTildeInPath
      guard !normalized.isEmpty else {
        return false
      }

      return seen.insert(normalized).inserted
    }
  }

  private func resolveExecutable(named name: String, searchPaths: [String]) -> URL? {
    for path in searchPaths {
      let candidate = URL(fileURLWithPath: path, isDirectory: true).appendingPathComponent(name)
      if FileManager.default.isExecutableFile(atPath: candidate.path) {
        return candidate.resolvingSymlinksInPath()
      }
    }

    return nil
  }

  private func buildDiagnostic(title: String, exists: Bool, okDetail: String, missingDetail: String) -> AgentDiagnosticItem {
    AgentDiagnosticItem(
      title: title,
      detail: exists ? okDetail : missingDetail,
      status: exists ? .ok : .missing
    )
  }

  private static func loadConfiguration() -> AgentBootstrapConfiguration? {
    let appSupportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
    let configURL = appSupportURL?.appendingPathComponent("config.json")

    guard let configURL,
          let data = try? Data(contentsOf: configURL),
          var configuration = try? JSONDecoder().decode(AgentBootstrapConfiguration.self, from: data) else {
      return nil
    }

    configuration.normalize()
    return configuration
  }

  static func normalizeVersionTag(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return "v0.0.0-dev"
    }

    let sanitized = trimmed.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? trimmed
    return sanitized.hasPrefix("v") ? sanitized : "v\(sanitized)"
  }
}

@MainActor
struct AgentSetupWindow: View {
  @ObservedObject var bootstrap: AgentBootstrapStore
  let onInstall: () -> Void
  let onCodexLogin: (String, String?) -> Void
  @Environment(\.openWindow) private var openWindow
  @State private var sensitiveConnectionExpanded = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        diagnosticsCard

        configurationCard(title: "기본 정보", icon: "person.crop.circle") {
          settingField("로그인 ID", text: $bootstrap.configuration.ownerLoginId)
          settingField("디바이스 이름", text: $bootstrap.configuration.deviceName)
          folderField("워크스페이스 루트", text: $bootstrap.configuration.workspaceRoots) {
            bootstrap.selectWorkspaceRoot()
          }
        }

        configurationCard(title: "연결 설정", icon: "lock.shield") {
          VStack(alignment: .leading, spacing: 0) {
            Button {
              sensitiveConnectionExpanded.toggle()
            } label: {
              HStack(alignment: .center, spacing: 0) {
                Image(systemName: sensitiveConnectionExpanded ? "chevron.down" : "chevron.right")
                  .font(.system(size: 11, weight: .semibold))
                  .padding(.leading, 12)
                  .padding(.trailing, 4)
                Text("연결 값")
                  .font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if sensitiveConnectionExpanded {
            VStack(alignment: .leading, spacing: 12) {
              settingField("NATS URL", text: $bootstrap.configuration.natsUrl)
              settingField("Bridge Host", text: $bootstrap.configuration.bridgeHost)
              settingField("Bridge Port", text: $bootstrap.configuration.bridgePort)
              secureSettingField("Bridge Token", text: $bootstrap.configuration.bridgeToken)
              pickerField("App Server Mode", selection: $bootstrap.configuration.appServerMode, options: bootstrap.appServerModeOptions)
              settingField("App Server WS URL", text: $bootstrap.configuration.appServerWsUrl)
            }
            .padding(.top, 12)
            }
          }
        }

        configurationCard(title: "Codex 로그인", icon: "person.badge.key") {
          codexLoginField
        }

        configurationCard(title: "Codex 실행 정책", icon: "slider.horizontal.3") {
          pickerField("모델", selection: $bootstrap.configuration.codexModel, options: bootstrap.modelOptions)
          pickerField("추론 강도", selection: $bootstrap.configuration.reasoningEffort, options: bootstrap.reasoningOptions)
          pickerField(
            "승인 정책",
            selection: $bootstrap.configuration.approvalPolicy,
            options: bootstrap.approvalOptions,
            optionLabel: bootstrap.approvalOptionLabel(for:)
          )
          pickerField(
            "샌드박스",
            selection: $bootstrap.configuration.sandboxMode,
            options: bootstrap.sandboxOptions,
            optionLabel: bootstrap.sandboxOptionLabel(for:)
          )
          settingField("Watchdog (ms)", text: $bootstrap.configuration.watchdogIntervalMs)
          settingField("Stale (ms)", text: $bootstrap.configuration.staleMs)
          toggleField("로그인 시 자동 실행", isOn: $bootstrap.configuration.autoStartAtLogin)
        }

        HStack {
          Spacer()

          if let savedAt = bootstrap.configurationSavedAt {
            Text(savedAt.formatted(date: .omitted, time: .standard))
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          Button("로그 보기") {
            openWindow(id: "logs")
          }

          Button(bootstrap.bootstrapInProgress ? "설치 중..." : "런타임 다시 설치") {
            onInstall()
          }
          .disabled(bootstrap.bootstrapInProgress)

          Button("설정 저장") {
            bootstrap.saveConfiguration()
          }
          .buttonStyle(.borderedProminent)
        }
      }
      .padding(18)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(
      LinearGradient(
        colors: [
          Color(nsColor: .windowBackgroundColor),
          Color(nsColor: .underPageBackgroundColor)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    )
    .background(WindowTitleConfigurator(title: "환경설정"))
    .frame(minWidth: 520, minHeight: 680)
    .task {
      await bootstrap.refreshCodexLoginStatus()
    }
  }

  private var diagnosticsCard: some View {
    configurationCard(title: "설치 진단", icon: "checklist") {
      ForEach(bootstrap.diagnostics) { item in
        HStack(alignment: .center, spacing: 10) {
          Circle()
            .fill(color(for: item.status))
            .frame(width: 10, height: 10)
          Text(item.title)
            .font(.subheadline.weight(.semibold))
          Spacer()
          Text(item.status.rawValue)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color(for: item.status))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
              Capsule(style: .continuous)
                .fill(color(for: item.status).opacity(0.12))
            )
        }
      }
    }
  }

  private func configurationCard<Content: View>(title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Label(title, systemImage: icon)
        .font(.headline)
      content()
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(Color(nsColor: .controlBackgroundColor))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .stroke(Color.primary.opacity(0.06), lineWidth: 1)
    )
  }

  private func settingField(_ title: String, text: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      TextField(title, text: text)
        .textFieldStyle(.roundedBorder)
    }
  }

  private func secureSettingField(_ title: String, text: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      SecureField(title, text: text)
        .textFieldStyle(.roundedBorder)
    }
  }

  private func folderField(_ title: String, text: Binding<String>, onBrowse: @escaping () -> Void) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      HStack(spacing: 10) {
        Text(text.wrappedValue.isEmpty ? "선택된 폴더 없음" : text.wrappedValue)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Color(nsColor: .textBackgroundColor))
          )
        Button("폴더 선택") {
          onBrowse()
        }
      }
    }
  }

  private func pickerField(
    _ title: String,
    selection: Binding<String>,
    options: [String],
    optionLabel: ((String) -> String)? = nil
  ) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      Picker("", selection: selection) {
        ForEach(options, id: \.self) { option in
          Text(optionLabel?(option) ?? option).tag(option)
        }
      }
      .labelsHidden()
      .pickerStyle(.menu)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var codexLoginField: some View {
    let fixedAuthMode = AgentBootstrapConfiguration.chatGptAuthMode
    let isApiKeyMode = fixedAuthMode == AgentBootstrapConfiguration.authModeApiKey
    let trimmedApiKey = bootstrap.authApiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
    let isApiKeyMissing = isApiKeyMode && trimmedApiKey.isEmpty && !bootstrap.hasStoredApiKey

    return VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 8) {
        Text("인증 방식")
          .font(.caption)
          .foregroundStyle(.secondary)
        Text("chatgpt-login")
          .font(.body)
          .fontWeight(.semibold)
      }

      if !bootstrap.codexLoggedIn,
         !bootstrap.codexLoginStatus.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text(bootstrap.codexLoginStatus)
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      HStack(alignment: .center, spacing: 14) {
        Group {
          if !bootstrap.codexLoginStatusResolved {
            Text("로그인 상태 확인 중...")
              .font(.footnote)
              .foregroundStyle(.secondary)
          } else if bootstrap.codexLoggedIn,
             !bootstrap.codexLoginStatus.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(bootstrap.codexLoginStatus)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(.middle)
          } else {
            Text("로그인 중 문제가 생기면 재시작 후 다시 로그인 가능.")
              .font(.system(size: 11.9))
              .foregroundStyle(.secondary)
              .padding(.leading, 14.7)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        Spacer(minLength: 0)

        Group {
          if bootstrap.codexLoginInProgress {
            Button {
            } label: {
              Text("확인 중")
                .frame(minWidth: 112)
            }
            .buttonStyle(.bordered)
          } else if bootstrap.codexLoggedIn {
            Button {
              onCodexLogin(
                fixedAuthMode,
                isApiKeyMode ? trimmedApiKey : nil
              )
            } label: {
              Text("계정 전환")
                .frame(minWidth: 112)
            }
            .buttonStyle(.bordered)
          } else {
            Button {
              onCodexLogin(
                fixedAuthMode,
                isApiKeyMode ? trimmedApiKey : nil
              )
            } label: {
              Text("로그인")
                .frame(minWidth: 112)
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .disabled(bootstrap.codexLoginInProgress || isApiKeyMissing)
      }
    }
  }

  private func valueField(_ title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(value)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color(nsColor: .textBackgroundColor))
        )
    }
  }

  private func toggleField(_ title: String, isOn: Binding<Bool>) -> some View {
    HStack(alignment: .center, spacing: 12) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)

      Spacer()

      Toggle("", isOn: isOn)
        .labelsHidden()
        .toggleStyle(.switch)
    }
  }

  private func color(for status: AgentDiagnosticItem.Status) -> Color {
    switch status {
    case .ok:
      return .green
    case .warning:
      return .orange
    case .missing:
      return .red
    }
  }
}

private struct WindowTitleConfigurator: NSViewRepresentable {
  let title: String

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async {
      view.window?.title = title
    }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async {
      nsView.window?.title = title
    }
  }
}
