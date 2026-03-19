import AppKit
import Darwin
import Foundation
import SwiftUI

private let codexDeviceAuthDefaultURL = URL(string: "https://auth.openai.com/codex/device")!

private struct CodexBrowserOption: Identifiable {
  let id: String
  let displayName: String
  let appURL: URL
  let icon: NSImage
}

private final class CodexDeviceAuthState: @unchecked Sendable {
  private let lock = NSLock()
  private var loginURL: URL?
  private var deviceCode: String?
  private var browserOpened = false

  func register(line: String) -> URL? {
    lock.lock()
    defer { lock.unlock() }

    if loginURL == nil,
       let range = line.range(of: #"https://\S+"#, options: .regularExpression) {
      loginURL = URL(string: String(line[range]))
    }

    if deviceCode == nil,
       let range = line.range(of: #"\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b"#, options: .regularExpression) {
      deviceCode = String(line[range])
    }

    guard !browserOpened else {
      return nil
    }

    if let loginURL {
      browserOpened = true
      return loginURL
    }

    if deviceCode != nil {
      browserOpened = true
      return codexDeviceAuthDefaultURL
    }

    return nil
  }
}

@MainActor
private final class CodexBrowserPickerController: NSObject {
  let panel: NSPanel
  let optionsById: [String: CodexBrowserOption]
  var selectedBrowser: CodexBrowserOption?

  init(panel: NSPanel, optionsById: [String: CodexBrowserOption]) {
    self.panel = panel
    self.optionsById = optionsById
  }

  @objc func chooseBrowser(_ sender: NSButton) {
    guard let identifier = sender.identifier?.rawValue,
          let option = optionsById[identifier] else {
      return
    }

    selectedBrowser = option
    NSApp.stopModal(withCode: .OK)
    panel.orderOut(nil)
  }

  @objc func cancel(_ sender: NSButton) {
    NSApp.stopModal(withCode: .cancel)
    panel.orderOut(nil)
  }
}

private enum CodexBrowserSelection {
  private static let browserCandidates: [(bundleID: String, displayName: String)] = [
    ("com.apple.Safari", "Safari"),
    ("com.google.Chrome", "Google Chrome"),
    ("com.microsoft.edgemac", "Microsoft Edge"),
    ("company.thebrowser.Browser", "Arc"),
    ("com.brave.Browser", "Brave"),
    ("org.mozilla.firefox", "Firefox")
  ]

  @MainActor
  static func selectBrowser() -> CodexBrowserOption? {
    let browsers = discoverBrowsers()
    guard !browsers.isEmpty else {
      return nil
    }

    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 520, height: 240),
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
    buttonStack.spacing = 12
    buttonStack.alignment = .centerY
    buttonStack.distribution = .fillEqually

    var optionMap: [String: CodexBrowserOption] = [:]
    for browser in browsers {
      optionMap[browser.id] = browser

      let button = NSButton(title: browser.displayName, target: nil, action: nil)
      button.identifier = NSUserInterfaceItemIdentifier(browser.id)
      button.image = browser.icon
      button.imageScaling = .scaleProportionallyDown
      button.imagePosition = .imageAbove
      button.setButtonType(.momentaryPushIn)
      button.bezelStyle = .rounded
      button.font = .systemFont(ofSize: 12, weight: .medium)
      button.translatesAutoresizingMaskIntoConstraints = false
      button.widthAnchor.constraint(equalToConstant: 92).isActive = true
      button.heightAnchor.constraint(equalToConstant: 92).isActive = true
      buttonStack.addArrangedSubview(button)
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
      rootStack.topAnchor.constraint(equalTo: contentView.topAnchor),
      rootStack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor)
    ])

    let controller = CodexBrowserPickerController(panel: panel, optionsById: optionMap)
    for case let button as NSButton in buttonStack.arrangedSubviews {
      button.target = controller
      button.action = #selector(CodexBrowserPickerController.chooseBrowser(_:))
    }
    cancelButton.target = controller
    cancelButton.action = #selector(CodexBrowserPickerController.cancel(_:))

    NSApp.activate(ignoringOtherApps: true)
    panel.center()
    panel.makeKeyAndOrderFront(nil)
    let response = NSApp.runModal(for: panel)
    panel.close()
    return response == .OK ? controller.selectedBrowser : nil
  }

  @MainActor
  static func open(_ url: URL, using browser: CodexBrowserOption) {
    NSWorkspace.shared.open(
      [url],
      withApplicationAt: browser.appURL,
      configuration: NSWorkspace.OpenConfiguration(),
      completionHandler: nil
    )
  }

  @MainActor
  private static func discoverBrowsers() -> [CodexBrowserOption] {
    browserCandidates.compactMap { candidate in
      guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: candidate.bundleID) else {
        return nil
      }

      let icon = NSWorkspace.shared.icon(forFile: appURL.path)
      icon.size = NSSize(width: 32, height: 32)
      return CodexBrowserOption(
        id: candidate.bundleID,
        displayName: candidate.displayName,
        appURL: appURL,
        icon: icon
      )
    }
  }
}

struct AgentLaunchContext {
  let nodeExecutableURL: URL
  let workspaceURL: URL
  let environment: [String: String]
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
  var autoUpdateEnabled: Bool
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
    case autoUpdateEnabled
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
    autoUpdateEnabled: Bool,
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
    self.autoUpdateEnabled = autoUpdateEnabled
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
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      watchdogIntervalMs: "15000",
      staleMs: "120000",
      autoStartAtLogin: true,
      autoUpdateEnabled: true,
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
    autoUpdateEnabled = try container.decodeIfPresent(Bool.self, forKey: .autoUpdateEnabled) ?? defaults.autoUpdateEnabled
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
    try container.encode(autoUpdateEnabled, forKey: .autoUpdateEnabled)
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

@MainActor
final class AgentBootstrapStore: ObservableObject {
  @Published var configuration: AgentBootstrapConfiguration
  @Published var diagnostics: [AgentDiagnosticItem] = []
  @Published var bootstrapInProgress = false
  @Published var bootstrapSummary = "환경설정 필요"
  @Published var codexLoginStatus = "확인 전"
  @Published var configurationSavedAt: Date? = nil
  @Published var lastBootstrapAt: Date? = nil
  private var automaticBootstrapAttempted = false
  private var automaticUpdateAttempted = false
  private var bootstrapTask: Task<Bool, Never>? = nil

  init() {
    configuration = Self.loadConfiguration() ?? .default()
    refreshDiagnostics()
  }

  let appServerModeOptions = ["ws-local"]
  let modelOptions = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1-codex-mini"]
  let reasoningOptions = ["none", "low", "medium", "high", "xhigh"]
  let approvalOptions = ["never", "on-request", "untrusted"]
  let sandboxOptions = ["workspace-write", "danger-full-access", "read-only"]
  let authModeOptions = [AgentBootstrapConfiguration.authModeDeviceAuth]

  var appSupportURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true) ?? URL(fileURLWithPath: NSHomeDirectory())
      .appendingPathComponent("Library/Application Support/OctOPAgentMenu", isDirectory: true)
  }

  var runtimeURL: URL {
    appSupportURL.appendingPathComponent("runtime", isDirectory: true)
  }

  var codexHomeURL: URL {
    appSupportURL.appendingPathComponent("codex-home", isDirectory: true)
  }

  var stateHomeURL: URL {
    appSupportURL.appendingPathComponent("state", isDirectory: true)
  }

  var runtimeWorkspaceURL: URL {
    runtimeURL.appendingPathComponent("workspace", isDirectory: true)
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
    runtimeURL.appendingPathComponent("version.txt")
  }

  var configurationURL: URL {
    appSupportURL.appendingPathComponent("config.json")
  }

  var launchAgentURL: URL {
    URL(fileURLWithPath: NSString(string: "~/Library/LaunchAgents/app.diffcolor.octop.agentmenu.launcher.plist").expandingTildeInPath)
  }

  var currentAppVersionTag: String {
    if let rawValue = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
      return Self.normalizeVersionTag(rawValue)
    }

    return "v0.0.0-dev"
  }

  var currentAppVersionDisplay: String {
    currentAppVersionTag
  }

  var runtimeVersionDisplay: String {
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
      try ensureDirectory(runtimeURL)
      try writeRuntimeEnvironmentFile()
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
    let status = await currentCodexLoginStatus()
    codexLoginStatus = status.summary
  }

  func ensureAppUpdatedIfNeeded(log: @escaping @MainActor (String) -> Void, force: Bool = false) async -> Bool {
    guard force || !automaticUpdateAttempted else {
      return false
    }

    automaticUpdateAttempted = true
    guard configuration.autoUpdateEnabled else {
      log("자동 업데이트가 비활성화되어 앱 업데이트 확인을 건너뜁니다.")
      return false
    }

    return await applyAppUpdateIfNeeded(log: log)
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
    let managedWorkspaceExists = FileManager.default.fileExists(atPath: runtimeWorkspaceURL.path)
    let launchAgentExists = FileManager.default.fileExists(atPath: launchAgentURL.path)
    let bundleBootstrapExists = bundleBootstrapURL != nil

    diagnostics = [
      buildDiagnostic(
        title: "앱 런타임 워크스페이스",
        exists: managedWorkspaceExists,
        okDetail: runtimeWorkspaceURL.path,
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

    if !FileManager.default.fileExists(atPath: runtimeWorkspaceURL.path) {
      return true
    }

    if !FileManager.default.fileExists(atPath: runtimeEnvURL.path) {
      return true
    }

    if !FileManager.default.fileExists(atPath: runtimeVersionURL.path) {
      return true
    }

    for requiredPath in requiredRuntimeWorkspacePaths() {
      if !FileManager.default.fileExists(atPath: requiredPath.path) {
        return true
      }
    }

    let runtimeVersion = (try? String(contentsOf: runtimeVersionURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? ""
    if Self.normalizeVersionTag(runtimeVersion) != currentAppVersionTag {
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

    guard FileManager.default.fileExists(atPath: runtimeWorkspaceURL.path) else {
      throw AgentBootstrapError.bundleBootstrapUnavailable
    }

    return AgentLaunchContext(
      nodeExecutableURL: runtimeNodeURL,
      workspaceURL: runtimeWorkspaceURL,
      environment: buildLaunchEnvironment()
    )
  }

  func ensureReadyForLaunch(log: @escaping @MainActor (String) -> Void) async -> Bool {
    if let bootstrapTask {
      return await bootstrapTask.value
    }

    if !requiresBootstrap {
      let status = await currentCodexLoginStatus()
      codexLoginStatus = status.summary
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

  private func performBootstrap(log: @escaping @MainActor (String) -> Void) async throws {
    try persistConfiguration()
    try ensureDirectory(appSupportURL)
    try ensureDirectory(runtimeURL)
    try ensureDirectory(runtimeBinURL)
    try ensureDirectory(codexHomeURL)
    try ensureDirectory(stateHomeURL)

    log("bootstrap 런타임을 스테이징합니다.")
    try stageBundledRuntime()

    log("관리형 node를 준비합니다.")
    try await ensureManagedNode(log: log)

    log("codex 실행 파일을 준비합니다.")
    try await ensureManagedCodex(log: log)

    log("npm 의존성을 설치합니다.")
    try await installRuntimeDependencies(log: log)

    log("환경 설정 파일을 생성합니다.")
    try writeRuntimeEnvironmentFile()

    try writeRuntimeVersion()

    log("Codex 로그인 상태를 확인합니다.")
    try await ensureCodexLogin(log: log)

    log("LaunchAgent를 설치합니다.")
    try installLaunchAgent(enabled: configuration.autoStartAtLogin, log: log)
  }

  private func stageBundledRuntime() throws {
    guard let sourceURL = bundleBootstrapURL else {
      throw AgentBootstrapError.bundleBootstrapUnavailable
    }

    if FileManager.default.fileExists(atPath: runtimeWorkspaceURL.path) {
      try FileManager.default.removeItem(at: runtimeWorkspaceURL)
    }

    try copyDirectoryContents(from: sourceURL, to: runtimeWorkspaceURL)
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

  private func installRuntimeDependencies(log: @escaping @MainActor (String) -> Void) async throws {
    guard FileManager.default.fileExists(atPath: runtimeNpmCliURL.path) else {
      throw AgentBootstrapError.npmUnavailable
    }

    let packageURL = runtimeWorkspaceURL.appendingPathComponent("services/codex-adapter/package.json")
    guard FileManager.default.fileExists(atPath: packageURL.path) else {
      throw AgentBootstrapError.bundleBootstrapUnavailable
    }

    try await runProcess(
      executableURL: runtimeNodeURL,
      arguments: [runtimeNpmCliURL.path, "install", "--omit=dev"],
      environment: buildProcessEnvironment(),
      currentDirectoryURL: runtimeWorkspaceURL.appendingPathComponent("services/codex-adapter", isDirectory: true),
      log: log
    )
  }

  private func ensureCodexLogin(log: @escaping @MainActor (String) -> Void) async throws {
    let status = await currentCodexLoginStatus()
    codexLoginStatus = status.summary
    if status.loggedIn {
      log("Codex 로그인 상태를 재사용합니다.")
      return
    }

    log("ChatGPT 로그인을 시작합니다.")
    try await loginWithBrowserSelection(log: log, logoutFirst: false)
  }

  func reloginCodex(log: @escaping @MainActor (String) -> Void) async {
    bootstrapInProgress = true
    bootstrapSummary = "Codex 계정 전환 중"

    do {
      try await loginWithBrowserSelection(log: log, logoutFirst: true)
      let status = await currentCodexLoginStatus()
      codexLoginStatus = status.summary
      bootstrapSummary = status.loggedIn ? "Codex 계정 전환 완료" : "Codex 로그인 필요"
    } catch {
      bootstrapSummary = "Codex 계정 전환 실패: \(error.localizedDescription)"
      log("Codex 계정 전환 실패: \(error.localizedDescription)")
    }

    bootstrapInProgress = false
    refreshDiagnostics()
  }

  func loginCodex(log: @escaping @MainActor (String) -> Void) async {
    bootstrapInProgress = true
    bootstrapSummary = "Codex 로그인 진행 중"

    do {
      try await loginWithBrowserSelection(log: log, logoutFirst: false)
      let status = await currentCodexLoginStatus()
      codexLoginStatus = status.summary
      bootstrapSummary = status.loggedIn ? "Codex 로그인 완료" : "Codex 로그인 필요"
    } catch {
      bootstrapSummary = "Codex 로그인 실패: \(error.localizedDescription)"
      log("Codex 로그인 실패: \(error.localizedDescription)")
    }

    bootstrapInProgress = false
    refreshDiagnostics()
  }

  private func writeRuntimeEnvironmentFile() throws {
    let workspaceRoots = configuration.workspaceRoots
      .split(separator: ",")
      .map { NSString(string: String($0)).expandingTildeInPath.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: ",")

    let envText = [
      "OCTOP_BRIDGE_OWNER_LOGIN_ID=\(configuration.ownerLoginId)",
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

    try envText.write(to: runtimeEnvURL, atomically: true, encoding: .utf8)
  }

  private func writeRuntimeVersion() throws {
    try currentAppVersionTag.write(to: runtimeVersionURL, atomically: true, encoding: .utf8)
  }

  private func installLaunchAgent(enabled: Bool, log: @escaping @MainActor (String) -> Void) throws {
    let bundlePath = Bundle.main.bundleURL.path
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

    try ensureDirectory(launchAgentURL.deletingLastPathComponent())
    try plist.write(to: launchAgentURL, atomically: true, encoding: .utf8)

    let uid = String(getuid())
    let launchctlURL = URL(fileURLWithPath: "/bin/launchctl")

    if enabled {
      log("LaunchAgent를 현재 세션에 로드합니다.")
      Task {
        try? await runProcess(
          executableURL: launchctlURL,
          arguments: ["bootout", "gui/\(uid)", launchAgentURL.path],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
        try? await runProcess(
          executableURL: launchctlURL,
          arguments: ["bootstrap", "gui/\(uid)", launchAgentURL.path],
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
          arguments: ["bootout", "gui/\(uid)", launchAgentURL.path],
          environment: buildProcessEnvironment(),
          currentDirectoryURL: nil,
          log: log
        )
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

  private func buildLaunchEnvironment() -> [String: String] {
    var environment = buildProcessEnvironment()
    environment["PATH"] = [
      runtimeNodePrefixURL.appendingPathComponent("bin").path,
      runtimeBinURL.path,
      environment["PATH"] ?? ""
    ].filter { !$0.isEmpty }.joined(separator: ":")

    let values: [String: String] = [
      "OCTOP_BRIDGE_OWNER_LOGIN_ID": configuration.ownerLoginId,
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

    return environment
  }

  private func appServerCommand() -> String {
    "\(shellEscape(runtimeCodexURL.path)) app-server --listen \(shellEscape(configuration.appServerWsUrl))"
  }

  private func shellEscape(_ value: String) -> String {
    let text = value.trimmingCharacters(in: .newlines)
    guard !text.isEmpty else {
      return "''"
    }

    return "'\(text.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }

  private func currentCodexLoginStatus() async -> (loggedIn: Bool, summary: String) {
    guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) else {
      return (false, "Codex 미설치")
    }

    var lines: [String] = []

    do {
      try await runProcess(
        executableURL: runtimeCodexURL,
        arguments: ["login", "status"],
        environment: buildLaunchEnvironment(),
        currentDirectoryURL: runtimeWorkspaceURL,
        log: { line in
          let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
          if !trimmed.isEmpty {
            lines.append(trimmed)
          }
        }
      )

      return (true, lines.last ?? "로그인됨")
    } catch {
      let summary = error.localizedDescription
        .split(whereSeparator: \.isNewline)
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .last { !$0.isEmpty } ?? "미로그인"
      return (false, summary)
    }
  }

  private func loginWithBrowserSelection(log: @escaping @MainActor (String) -> Void, logoutFirst: Bool) async throws {
    if logoutFirst {
      log("현재 Codex 로그인 계정을 로그아웃합니다.")
      try await logoutCodex(log: log)
    }

    guard let browser = await MainActor.run(body: { CodexBrowserSelection.selectBrowser() }) else {
      throw NSError(domain: "OctOPAgentMenu.Browser", code: 1, userInfo: [NSLocalizedDescriptionKey: "로그인에 사용할 브라우저 선택이 취소되었습니다."])
    }

    let deviceAuthState = CodexDeviceAuthState()

    try await runProcess(
      executableURL: runtimeCodexURL,
      arguments: ["login", "--device-auth"],
      environment: buildLaunchEnvironment(),
      currentDirectoryURL: runtimeWorkspaceURL,
      log: log,
      onOutputLine: { line in
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if let urlToOpen = deviceAuthState.register(line: trimmed) {
          Task { @MainActor in
            CodexBrowserSelection.open(urlToOpen, using: browser)
          }
        }
      }
    )

    let status = await currentCodexLoginStatus()
    codexLoginStatus = status.summary
  }

  private func logoutCodex(log: @escaping @MainActor (String) -> Void) async throws {
    guard FileManager.default.isExecutableFile(atPath: runtimeCodexURL.path) else {
      log("Codex CLI가 아직 준비되지 않아 로그아웃을 건너뜁니다.")
      return
    }

    try await runProcess(
      executableURL: runtimeCodexURL,
      arguments: ["logout"],
      environment: buildLaunchEnvironment(),
      currentDirectoryURL: runtimeWorkspaceURL,
      log: log
    )
  }

  private var bundleBootstrapURL: URL? {
    Bundle.module.resourceURL?.appendingPathComponent("bootstrap", isDirectory: true)
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

  private func requiredRuntimeWorkspacePaths() -> [URL] {
    [
      runtimeWorkspaceURL.appendingPathComponent("scripts/run-local-agent.mjs"),
      runtimeWorkspaceURL.appendingPathComponent("scripts/run-bridge.mjs"),
      runtimeWorkspaceURL.appendingPathComponent("scripts/shared-env.mjs"),
      runtimeWorkspaceURL.appendingPathComponent("services/codex-adapter/package.json"),
      runtimeWorkspaceURL.appendingPathComponent("services/codex-adapter/src/index.js"),
      runtimeWorkspaceURL.appendingPathComponent("services/codex-adapter/src/domain.js")
    ]
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
  let onLogin: () -> Void
  let onRelogin: () -> Void
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
          DisclosureGroup(isExpanded: $sensitiveConnectionExpanded) {
            VStack(alignment: .leading, spacing: 12) {
              settingField("NATS URL", text: $bootstrap.configuration.natsUrl)
              settingField("Bridge Host", text: $bootstrap.configuration.bridgeHost)
              settingField("Bridge Port", text: $bootstrap.configuration.bridgePort)
              secureSettingField("Bridge Token", text: $bootstrap.configuration.bridgeToken)
              pickerField("App Server Mode", selection: $bootstrap.configuration.appServerMode, options: bootstrap.appServerModeOptions)
              settingField("App Server WS URL", text: $bootstrap.configuration.appServerWsUrl)
            }
            .padding(.top, 12)
          } label: {
            Text("연결 값")
              .font(.subheadline.weight(.semibold))
          }
          .accentColor(.primary)
        }

        configurationCard(title: "Codex 실행 정책", icon: "slider.horizontal.3") {
          pickerField("모델", selection: $bootstrap.configuration.codexModel, options: bootstrap.modelOptions)
          pickerField("Reasoning", selection: $bootstrap.configuration.reasoningEffort, options: bootstrap.reasoningOptions)
          pickerField("Approval", selection: $bootstrap.configuration.approvalPolicy, options: bootstrap.approvalOptions)
          pickerField("Sandbox", selection: $bootstrap.configuration.sandboxMode, options: bootstrap.sandboxOptions)
          codexLoginField
          settingField("Watchdog (ms)", text: $bootstrap.configuration.watchdogIntervalMs)
          settingField("Stale (ms)", text: $bootstrap.configuration.staleMs)
          toggleField("로그인 시 자동 실행", isOn: $bootstrap.configuration.autoStartAtLogin)
          toggleField("자동 업데이트", isOn: $bootstrap.configuration.autoUpdateEnabled)
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
    VStack(alignment: .leading, spacing: 8) {
      Text("Codex 로그인")
        .font(.caption)
        .foregroundStyle(.secondary)

      Text(bootstrap.codexLoginStatus)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color(nsColor: .textBackgroundColor))
        )

      HStack(spacing: 10) {
        Button("브라우저 선택 로그인") {
          onLogin()
        }
        .disabled(bootstrap.bootstrapInProgress)

        Button("계정 전환") {
          onRelogin()
        }
        .disabled(bootstrap.bootstrapInProgress)
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
