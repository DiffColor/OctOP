import AppKit
import CryptoKit
import Darwin
import Foundation
import SwiftUI

private struct LocalCodexAuthStoreStatus {
  let loggedIn: Bool
  let summary: String
}

struct RuntimeUpdateDescriptor: Equatable {
  let sourceRevision: String
  let currentSourceRevision: String?

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

private let agentMenuDeclaredAppVersionTag = "v1.2.4"

private struct AgentRuntimeReleaseBuildInfo: Codable {
  let runtimeID: String
  let sourceHash: String
  let configurationHash: String
  let sourceRevision: String?
  let appVersion: String
  let createdAt: Date
}

private struct AgentRuntimeReleaseHealthcheck: Codable {
  let status: String
  let checkedAt: Date
  let checks: [String]
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
}

private struct AgentPreparedCodexAdapterSource {
  let sourceURL: URL
  let sourceRevision: String?
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
    authMode: String
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
      authMode: authModeDeviceAuth
    )
  }

  mutating func normalize() {
    if deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      deviceName = Self.currentDeviceName()
    }

    authMode = Self.authModeDeviceAuth
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
  @Published var configuration: AgentBootstrapConfiguration
  @Published var diagnostics: [AgentDiagnosticItem] = []
  @Published var bootstrapInProgress = false
  @Published var codexLoginInProgress = false
  @Published var bootstrapSummary = "환경설정 필요"
  @Published var codexLoginStatus = ""
  @Published var codexLoggedIn = false
  @Published var codexLoginStatusResolved = false
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
    ensureCodexHomeReady()
    refreshDiagnostics()
  }

  let appServerModeOptions = ["ws-local"]
  let modelOptions = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1-codex-mini"]
  let reasoningOptions = ["none", "low", "medium", "high", "xhigh"]
  let approvalOptions = ["on-request", "never", "untrusted"]
  let sandboxOptions = ["danger-full-access", "workspace-write", "read-only"]
  let authModeOptions = [AgentBootstrapConfiguration.authModeDeviceAuth]

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
    agentMenuDeclaredAppVersionTag
  }

  var currentAppVersionDisplay: String {
    currentAppVersionTag
  }

  private var appUpdateDataBackupURL: URL {
    URL(fileURLWithPath: appSupportURL.path + ".update-backup", isDirectory: true)
  }

  private var appUpdateDataBackupStagingURL: URL {
    URL(fileURLWithPath: appSupportURL.path + ".update-backup.staging", isDirectory: true)
  }

  private var appUpdatePreservedAppSupportURL: URL {
    appUpdateDataBackupURL.appendingPathComponent(appSupportURL.lastPathComponent, isDirectory: true)
  }

  var runtimeUpdateCheckIntervalSeconds: TimeInterval {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_RUNTIME_UPDATE_CHECK_INTERVAL_SECONDS"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       let interval = TimeInterval(overrideValue),
       interval >= 5 {
      return interval
    }

    return 60
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

  func preserveAppDataForUpdate(log: @escaping @MainActor (String) -> Void) throws {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: appSupportURL.path) else {
      return
    }

    if fileManager.fileExists(atPath: appUpdateDataBackupStagingURL.path) {
      try fileManager.removeItem(at: appUpdateDataBackupStagingURL)
    }

    try ensureDirectory(appUpdateDataBackupStagingURL.deletingLastPathComponent())
    try ensureDirectory(appUpdateDataBackupStagingURL)

    do {
      let backupURL = appUpdateDataBackupStagingURL.appendingPathComponent(appSupportURL.lastPathComponent, isDirectory: true)
      try fileManager.copyItem(at: appSupportURL, to: backupURL)

      if fileManager.fileExists(atPath: appUpdateDataBackupURL.path) {
        try fileManager.removeItem(at: appUpdateDataBackupURL)
      }

      try fileManager.moveItem(at: appUpdateDataBackupStagingURL, to: appUpdateDataBackupURL)
      log("앱 업데이트에 대비해 앱 로컬 데이터 전체를 백업했습니다.")
    } catch {
      if fileManager.fileExists(atPath: appUpdateDataBackupStagingURL.path) {
        try? fileManager.removeItem(at: appUpdateDataBackupStagingURL)
      }

      throw error
    }
  }

  func cleanupCompletedAppUpdateArtifacts(log: @escaping @MainActor (String) -> Void) {
    let fileManager = FileManager.default
    let cleanupTargets = [
      URL(fileURLWithPath: Bundle.main.bundleURL.path + ".previous-update", isDirectory: true),
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

  private func ensureCodexHomeReady(log: ((String) -> Void)? = nil) {
    do {
      try ensureDirectory(codexHomeURL)
    } catch {
      log?("전역 Codex 저장소를 준비하지 못했습니다: \(error.localizedDescription)")
    }
  }

  var runtimeVersionDisplay: String {
    if let activeRuntimeURL = currentRuntimeReleaseURL(),
       let buildInfo = loadRuntimeBuildInfo(at: activeRuntimeURL),
       let sourceRevision = buildInfo.sourceRevision?
         .trimmingCharacters(in: .whitespacesAndNewlines),
       !sourceRevision.isEmpty {
      return String(sourceRevision.prefix(12))
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
      try persistConfiguration()
      try installLaunchAgent(enabled: configuration.autoStartAtLogin, log: { _ in })
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
    let configurationHash = try computeRuntimeConfigurationHash()
    let runtimeRevisionLabel = preparedSource.sourceRevision?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .prefix(12)
    let runtimeID = "runtime-\(runtimeRevisionLabel.map(String.init) ?? String(sourceHash.prefix(12)))-\(String(configurationHash.prefix(12)))"
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
        sourceRevision: preparedCodexAdapter.sourceRevision
      )
    }

    log("원격 codex-adapter 소스를 가져오지 못해 앱 번들 런타임을 사용합니다.")
    return AgentPreparedRuntimeSource(rootURL: stagingSourceURL, sourceRevision: nil)
  }

  private func prepareLatestCodexAdapterSource(
    log: @escaping @MainActor (String) -> Void
  ) async throws -> AgentPreparedCodexAdapterSource? {
    if let overrideURL = codexAdapterSourceOverrideURL() {
      return AgentPreparedCodexAdapterSource(
        sourceURL: overrideURL,
        sourceRevision: gitRepositoryURL(containing: overrideURL).flatMap { gitRevisionIfAvailable(at: $0) }
      )
    }

    try ensureDirectory(runtimeSourceCacheURL)
    let repositoryURL = runtimeRepositoryCacheURL
    let branch = runtimeRepositoryBranch

    if FileManager.default.fileExists(atPath: repositoryURL.appendingPathComponent(".git").path) {
      do {
        log("codex-adapter 최신 소스를 가져옵니다. branch=\(branch)")
        try await runProcess(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: ["-C", repositoryURL.path, "fetch", "--depth", "1", "origin", branch],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
        try await runProcess(
          executableURL: URL(fileURLWithPath: "/usr/bin/git"),
          arguments: ["-C", repositoryURL.path, "reset", "--hard", "FETCH_HEAD"],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
      } catch {
        log("codex-adapter 최신화에 실패해 마지막 캐시를 사용합니다: \(error.localizedDescription)")
      }
    } else {
      do {
        log("codex-adapter 소스 저장소를 초기화합니다.")
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
          log: log
        )
      } catch {
        log("codex-adapter 저장소 초기화에 실패했습니다: \(error.localizedDescription)")
        return nil
      }
    }

    let codexAdapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)

    guard FileManager.default.fileExists(atPath: codexAdapterURL.appendingPathComponent("package.json").path) else {
      log("가져온 저장소에 codex-adapter가 없어 앱 번들 런타임을 사용합니다.")
      return nil
    }

    return AgentPreparedCodexAdapterSource(
      sourceURL: codexAdapterURL,
      sourceRevision: gitRevisionIfAvailable(at: repositoryURL)
    )
  }

  private func resolveAvailableRuntimeUpdate() async throws -> RuntimeUpdateDescriptor? {
    guard let latestRevision = try await resolveLatestRuntimeSourceRevision()?
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

  private func resolveLatestRuntimeSourceRevision() async throws -> String? {
    if let runtimeUpdateRevisionResolver {
      return try await runtimeUpdateRevisionResolver(self)
    }

    if let overrideURL = codexAdapterSourceOverrideURL(),
       let repositoryURL = gitRepositoryURL(containing: overrideURL),
       let revision = gitRevisionIfAvailable(at: repositoryURL) {
      return revision
    }

    let process = Process()
    let output = Pipe()
    let error = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = [
      "ls-remote",
      runtimeRepositoryRemoteURL,
      "refs/heads/\(runtimeRepositoryBranch)"
    ]
    process.standardOutput = output
    process.standardError = error
    process.environment = buildProcessEnvironment()

    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
      let detail = String(
        decoding: error.fileHandleForReading.readDataToEndOfFile(),
        as: UTF8.self
      ).trimmingCharacters(in: .whitespacesAndNewlines)
      throw NSError(domain: "OctOPAgentMenu.RuntimeUpdate", code: Int(process.terminationStatus), userInfo: [
        NSLocalizedDescriptionKey: detail.isEmpty ? "원격 codex-adapter 리비전을 조회하지 못했습니다." : detail
      ])
    }

    let text = String(
      decoding: output.fileHandleForReading.readDataToEndOfFile(),
      as: UTF8.self
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let revision = text.split(separator: "\t").first.map(String.init) ?? ""
    return revision.isEmpty ? nil : revision
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
    var fileURLs: [URL] = []
    try collectRuntimeSourceFiles(at: sourceURL, into: &fileURLs)

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

  private func collectRuntimeSourceFiles(at rootURL: URL, into results: inout [URL]) throws {
    let entries = try FileManager.default.contentsOfDirectory(
      at: rootURL,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ).sorted { $0.path < $1.path }

    for entry in entries {
      let isDirectory = (try entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
      if isDirectory {
        try collectRuntimeSourceFiles(at: entry, into: &results)
      } else {
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

    log("ChatGPT 로그인을 시작합니다.")
    try await loginWithBrowserSelection(log: log, logoutFirst: false)
  }

  func reloginCodex(log: @escaping @MainActor (String) -> Void) async {
    bootstrapInProgress = true
    codexLoginInProgress = true
    codexLoginStatusResolved = false
    bootstrapSummary = "Codex 계정 전환 중"

    do {
      try await loginWithBrowserSelection(log: log, logoutFirst: true)
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

  func loginCodex(log: @escaping @MainActor (String) -> Void) async {
    bootstrapInProgress = true
    codexLoginInProgress = true
    codexLoginStatusResolved = false
    bootstrapSummary = "Codex 로그인 진행 중"

    do {
      try await loginWithBrowserSelection(log: log, logoutFirst: false)
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

  func handleCodexLoginAction(log: @escaping @MainActor (String) -> Void) async {
    await refreshCodexLoginStatus()
    if codexLoggedIn {
      await reloginCodex(log: log)
    } else {
      await loginCodex(log: log)
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
    for candidate in [bridgeIdURL, legacyBridgeIdURL] {
      if let value = try? String(contentsOf: candidate, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines),
         !value.isEmpty {
        try? persistBridgeId(value)
        return value
      }
    }

    let generated = "bridge-\(UUID().uuidString.lowercased())"
    try? persistBridgeId(generated)
    return generated
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
    let data = try encoder.encode(configuration)
    try data.write(to: configurationURL, options: .atomic)
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

  private func appServerCommand() -> String {
    "\(shellEscape(runtimeCodexURL.path)) app-server --listen \(shellEscape(configuration.appServerWsUrl))"
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

  private func loginWithBrowserSelection(log: @escaping @MainActor (String) -> Void, logoutFirst: Bool) async throws {
    guard let browserID = await CodexBrowserSelection.selectBrowserID() else {
      AgentLoginDebugLog.write("browser selection cancelled")
      throw NSError(domain: "OctOPAgentMenu.Browser", code: 1, userInfo: [NSLocalizedDescriptionKey: "로그인에 사용할 브라우저 선택이 취소되었습니다."])
    }
    log("선택한 브라우저로 로그인을 시작합니다.")
    AgentLoginDebugLog.write("browser selected: \(browserID)")

    let accountStatus = try await runBrowserLoginHelper(
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

  private func runBrowserLoginHelper(
    browserID: String,
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
          AgentLoginDebugLog.write("login start received: loginId=\(loginId)")
          savePendingLogin(loginId)
          postLog("로그인 URL 생성: \(authUrl)")
          postLog("선택한 브라우저 번들 ID: \(browserID)")
        case "browserOpened":
          AgentLoginDebugLog.write("browser open exit: bundle=\(browserID) status=0")
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
      process.arguments = [
        scriptURL.path,
        "--codex", runtimeCodexURL.path,
        "--browser-bundle-id", browserID
      ] + (logoutFirst ? ["--logout-first"] : [])
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
        AgentLoginDebugLog.write("login helper process start: browser=\(browserID)")
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
  let onCodexLogin: () -> Void
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
          pickerField("Reasoning", selection: $bootstrap.configuration.reasoningEffort, options: bootstrap.reasoningOptions)
          pickerField("Approval", selection: $bootstrap.configuration.approvalPolicy, options: bootstrap.approvalOptions)
          pickerField("Sandbox", selection: $bootstrap.configuration.sandboxMode, options: bootstrap.sandboxOptions)
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

  private func pickerField(_ title: String, selection: Binding<String>, options: [String]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption)
        .foregroundStyle(.secondary)
      Picker("", selection: selection) {
        ForEach(options, id: \.self) { option in
          Text(option).tag(option)
        }
      }
      .labelsHidden()
      .pickerStyle(.menu)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var codexLoginField: some View {
    VStack(alignment: .leading, spacing: 12) {
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
          if !bootstrap.codexLoginStatusResolved {
            Button {
            } label: {
              Text("확인 중")
                .frame(minWidth: 112)
            }
            .buttonStyle(.bordered)
          } else if bootstrap.codexLoggedIn {
            Button {
              onCodexLogin()
            } label: {
              Text("계정 전환")
                .frame(minWidth: 112)
            }
            .buttonStyle(.bordered)
          } else {
            Button {
              onCodexLogin()
            } label: {
              Text("로그인")
                .frame(minWidth: 112)
            }
            .buttonStyle(.borderedProminent)
          }
        }
        .disabled(bootstrap.codexLoginInProgress || !bootstrap.codexLoginStatusResolved)
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
