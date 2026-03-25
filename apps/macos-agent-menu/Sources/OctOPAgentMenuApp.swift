import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import SwiftUI
import Darwin

enum AgentRuntimeState: String {
  case stopped = "중지됨"
  case starting = "시작 중"
  case running = "실행 중"
  case stopping = "중지 중"
  case failed = "실패"
}

@MainActor
final class AgentMenuModel: ObservableObject {
  @Published var runtimeState: AgentRuntimeState = .stopped
  @Published var lastUpdatedAt: Date? = nil
  @Published var lines: [String] = []
  @Published var lastError: String? = nil
  @Published var processId: Int32? = nil

  private var process: Process? = nil
  private var stdoutPipe: Pipe? = nil
  private var stderrPipe: Pipe? = nil
  private let maxLines = 2000
  private let stopGracePeriodUsec: useconds_t = 3_000_000

  init() {
    refreshRuntimeStateFromSystem(logDetection: true)
  }

  lazy var colorMenuBarImage: NSImage = {
    Self.makeMenuBarImage(grayscale: false) ?? NSImage(systemSymbolName: "terminal.fill", accessibilityDescription: nil) ?? NSImage()
  }()

  lazy var grayscaleMenuBarImage: NSImage = {
    Self.makeMenuBarImage(grayscale: true) ?? colorMenuBarImage
  }()

  var isRunning: Bool {
    runtimeState == .running || runtimeState == .starting || runtimeState == .stopping
  }

  var menuBarImage: NSImage {
    switch runtimeState {
    case .running, .starting:
      colorMenuBarImage
    case .stopping, .stopped, .failed:
      grayscaleMenuBarImage
    }
  }

  func start(using bootstrap: AgentBootstrapStore) async {
    runtimeState = .starting
    lastError = nil
    appendLog("서비스 시작을 요청합니다.")

    let preparedReleaseURL: URL
    do {
      preparedReleaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: appendInstallerLog)
    } catch {
      runtimeState = .failed
      lastError = error.localizedDescription
      lastUpdatedAt = Date()
      appendLog("local-agent 시작 실패: \(error.localizedDescription)")
      return
    }

    let lingeringProcesses = findManagedProcesses()
    if !lingeringProcesses.isEmpty {
      appendLog("기존 서비스 프로세스를 먼저 정리합니다.")
      terminateManagedProcesses(lingeringProcesses)
    }

    let stopValidated = await validateManagedProcessShutdown(using: bootstrap)
    guard stopValidated else {
      runtimeState = .failed
      lastError = "기존 서비스 종료 검증에 실패했습니다."
      lastUpdatedAt = Date()
      appendLog("기존 서비스 종료 검증에 실패해 새 런타임 전환을 중단합니다.")
      return
    }

    let launchContext: AgentLaunchContext
    let previousReleaseURL: URL?
    do {
      previousReleaseURL = try bootstrap.activateRuntimeRelease(preparedReleaseURL, log: appendInstallerLog)
      launchContext = try bootstrap.makeLaunchContext()
    } catch {
      runtimeState = .failed
      lastError = error.localizedDescription
      lastUpdatedAt = Date()
      appendLog("local-agent 시작 실패: \(error.localizedDescription)")
      return
    }

    do {
      try launchService(with: launchContext)
      let launchValidated = await validateServiceLaunch(using: bootstrap)

      if !launchValidated,
         let previousReleaseURL,
         previousReleaseURL.standardizedFileURL != preparedReleaseURL.standardizedFileURL {
        appendLog("새 서비스 런타임 기동 확인에 실패해 이전 런타임으로 롤백합니다.")
        terminateManagedProcesses(findManagedProcesses())
        cleanupPipes()
        process = nil
        processId = nil

        try bootstrap.rollbackRuntimeRelease(to: previousReleaseURL, log: appendInstallerLog)
        let rollbackLaunchContext = try bootstrap.makeLaunchContext()
        try launchService(with: rollbackLaunchContext)
        _ = await validateServiceLaunch(using: bootstrap)
      }

      if runtimeState == .running {
        try? bootstrap.cleanupStaleRuntimeReleases(log: appendInstallerLog)
      }
    } catch {
      runtimeState = .failed
      lastError = error.localizedDescription
      lastUpdatedAt = Date()
      appendLog("local-agent 시작 실패: \(error.localizedDescription)")
      cleanupPipes()
      process = nil
      processId = nil
    }
  }

  func stop() {
    let managedProcesses = findManagedProcesses()

    guard !managedProcesses.isEmpty || process != nil else {
      runtimeState = .stopped
      appendLog("중지할 서비스가 없습니다.")
      return
    }

    runtimeState = .stopping
    processId = managedProcesses.first?.pid ?? process?.processIdentifier
    lastUpdatedAt = Date()
    appendLog("서비스 정지를 요청합니다.")

    terminateManagedProcesses(managedProcesses)
    cleanupPipes()
    process = nil
    processId = nil
    runtimeState = .stopped
    lastUpdatedAt = Date()
    appendLog("서비스 프로세스 정리가 완료되었습니다.")
  }

  func waitUntilStopped(timeoutNanoseconds: UInt64 = 5_000_000_000) async {
    let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds

    while DispatchTime.now().uptimeNanoseconds < deadline {
      refreshRuntimeStateFromSystem()
      if !isRunning {
        return
      }

      try? await Task.sleep(nanoseconds: 100_000_000)
    }

    refreshRuntimeStateFromSystem()
  }

  func handleApplicationWillTerminate() {
    let managedProcesses = findManagedProcesses()
    if !managedProcesses.isEmpty {
      appendLog("앱 종료에 맞춰 서비스와 보조 세션을 정리합니다.")
      terminateManagedProcesses(managedProcesses)
    }
  }

  func refreshRuntimeStateFromSystem(logDetection: Bool = false) {
    if let managedProcess = process, managedProcess.isRunning {
      processId = managedProcess.processIdentifier
      runtimeState = .running
      lastUpdatedAt = Date()
      return
    }

    let serviceProcesses = findServiceProcesses()

    guard let existingProcessId = serviceProcesses.first(where: { $0.command.contains("run-local-agent.mjs") })?.pid ?? serviceProcesses.first?.pid else {
      processId = nil
      if runtimeState != .failed {
        runtimeState = .stopped
      }
      lastUpdatedAt = Date()
      return
    }

    let shouldLog = logDetection && processId != existingProcessId
    processId = existingProcessId
    runtimeState = .running
    lastUpdatedAt = Date()

    if shouldLog {
      appendLog("기존 서비스 프로세스를 감지했습니다. pid=\(existingProcessId)")
    }
  }

  func clearLogs() {
    lines.removeAll(keepingCapacity: true)
    appendLog("로그를 초기화했습니다.")
  }

  func appendInstallerLog(_ message: String) {
    appendLog(message)
  }

  private func launchService(with launchContext: AgentLaunchContext) throws {
    cleanupPipes()

    let nextProcess = Process()
    let stdout = Pipe()
    let stderr = Pipe()
    let scriptURL = launchContext.workspaceURL.appendingPathComponent("scripts/run-local-agent.mjs")

    nextProcess.executableURL = launchContext.nodeExecutableURL
    nextProcess.arguments = [scriptURL.path]
    nextProcess.currentDirectoryURL = launchContext.workspaceURL
    nextProcess.standardOutput = stdout
    nextProcess.standardError = stderr
    nextProcess.environment = launchContext.environment

    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      Task { @MainActor in
        self?.appendStreamText(data)
      }
    }

    stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      Task { @MainActor in
        self?.appendStreamText(data)
      }
    }

    nextProcess.terminationHandler = { [weak self] process in
      Task { @MainActor in
        self?.handleTermination(process)
      }
    }

    try nextProcess.run()
    process = nextProcess
    stdoutPipe = stdout
    stderrPipe = stderr
    processId = nextProcess.processIdentifier
    runtimeState = .running
    lastUpdatedAt = Date()
    appendLog("서비스가 시작되었습니다. pid=\(nextProcess.processIdentifier)")
  }

  private func validateServiceLaunch(using bootstrap: AgentBootstrapStore) async -> Bool {
    let deadline = Date().addingTimeInterval(10)

    while Date() < deadline {
      refreshRuntimeStateFromSystem()
      let checks = await serviceLaunchChecks(using: bootstrap)
      if checks.allSatisfy(\.passed) {
        try? bootstrap.recordRuntimeHealthcheck(
          for: bootstrap.activeRuntimeReleaseURL ?? bootstrap.runtimeWorkspaceURL,
          status: "running",
          checks: checks.map(\.message),
          log: appendInstallerLog
        )
        return true
      }

      try? await Task.sleep(nanoseconds: 250_000_000)
    }

    let failedChecks = await serviceLaunchChecks(using: bootstrap)
    let checkMessages = failedChecks.map { check in
      check.passed ? check.message : "\(check.message) 실패"
    }
    try? bootstrap.recordRuntimeHealthcheck(
      for: bootstrap.activeRuntimeReleaseURL ?? bootstrap.runtimeWorkspaceURL,
      status: "failed",
      checks: checkMessages,
      log: appendInstallerLog
    )
    if let firstFailedCheck = failedChecks.first(where: { !$0.passed }) {
      appendLog("서비스 헬스체크 실패: \(firstFailedCheck.message)")
    }
    return false
  }

  private func validateManagedProcessShutdown(using bootstrap: AgentBootstrapStore) async -> Bool {
    let deadline = Date().addingTimeInterval(5)

    while Date() < deadline {
      let remainingManagedProcesses = findManagedProcesses()
      let bridgePortsReleased = configuredPortListenersReleased(
        host: bootstrap.configuration.bridgeHost,
        portText: bootstrap.configuration.bridgePort
      )
      let appServerPortReleased = configuredPortListenersReleased(
        host: nil,
        portText: bootstrap.configuration.appServerWsUrl,
        isURL: true
      )

      if remainingManagedProcesses.isEmpty && bridgePortsReleased && appServerPortReleased {
        return true
      }

      try? await Task.sleep(nanoseconds: 250_000_000)
    }

    return false
  }

  private func appendStreamText(_ data: Data) {
    let text = String(decoding: data, as: UTF8.self)
    for rawLine in text.split(whereSeparator: \.isNewline) {
      appendLog(String(rawLine))
    }
  }

  private func appendLog(_ message: String) {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    let line = "[\(formatter.string(from: Date()))] \(message)"
    lines.append(line)
    if lines.count > maxLines {
      lines.removeFirst(lines.count - maxLines)
    }
    lastUpdatedAt = Date()
  }

  private func handleTermination(_ terminatedProcess: Process) {
    cleanupPipes()
    let status = terminatedProcess.terminationStatus
    let reason = terminatedProcess.terminationReason
    process = nil
    processId = nil

    if runtimeState == .stopping || (reason == .exit && status == 0) {
      runtimeState = .stopped
    } else {
      runtimeState = .failed
      lastError = "종료 코드 \(status)"
    }

    appendLog("local-agent 종료됨. reason=\(reason.rawValue) status=\(status)")
    lastUpdatedAt = Date()
  }

  private func cleanupPipes() {
    stdoutPipe?.fileHandleForReading.readabilityHandler = nil
    stderrPipe?.fileHandleForReading.readabilityHandler = nil
    stdoutPipe = nil
    stderrPipe = nil
  }

  private func isProcessAlive(_ pid: Int32) -> Bool {
    if kill(pid, 0) == 0 {
      return true
    }

    return errno == EPERM
  }

  private func findManagedProcesses() -> [AgentProcessDescriptor] {
    findRuntimeProcesses(includeAuxiliarySessions: true)
  }

  private func findServiceProcesses() -> [AgentProcessDescriptor] {
    findRuntimeProcesses(includeAuxiliarySessions: false)
  }

  private func findRuntimeProcesses(includeAuxiliarySessions: Bool) -> [AgentProcessDescriptor] {
    let runtimePath = runtimeRootPath()
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    process.arguments = ["-fal", runtimePath]
    process.standardOutput = output
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return []
    }

    guard process.terminationStatus == 0 else {
      return []
    }

    let data = output.fileHandleForReading.readDataToEndOfFile()
    let text = String(decoding: data, as: UTF8.self)
    var results: [AgentProcessDescriptor] = []

    for line in text.split(whereSeparator: \.isNewline) {
      let columns = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
      guard columns.count == 2,
            let pid = Int32(columns[0]) else {
        continue
      }

      let command = String(columns[1])
      guard !command.contains("/usr/bin/pgrep"),
            isRuntimeProcessCommand(
              command,
              runtimePath: runtimePath,
              includeAuxiliarySessions: includeAuxiliarySessions
            ) else {
        continue
      }

      let pgid = getpgid(pid)
      results.append(AgentProcessDescriptor(pid: pid, pgid: pgid > 0 ? pgid : pid, command: command))
    }

    return results
  }

  private func serviceLaunchChecks(using bootstrap: AgentBootstrapStore) async -> [AgentLaunchCheck] {
    let serviceProcesses = findServiceProcesses()
    let currentRuntimePath = bootstrap.runtimeWorkspaceURL.path
    let localAgentProcess = serviceProcesses.first(where: { $0.command.contains("run-local-agent.mjs") })
    let bridgeLauncherProcess = serviceProcesses.first(where: { $0.command.contains("run-bridge.mjs") })
    let adapterProcess = serviceProcesses.first(where: { $0.command.contains("services/codex-adapter/src/index.js") })
    let wsProcess = serviceProcesses.first(where: { $0.command.contains("/runtime/bin/codex app-server --listen ws://") })
    let adapterPorts = adapterProcess.map(listeningTCPPorts(for:)) ?? []
    let wsPorts = wsProcess.map(listeningTCPPorts(for:)) ?? []
    let bridgeHealth = await fetchBridgeHealthStatus(
      host: bootstrap.configuration.bridgeHost,
      port: adapterPorts.first,
      bridgeToken: bootstrap.configuration.bridgeToken,
      ownerLoginId: bootstrap.configuration.ownerLoginId
    )

    return [
      AgentLaunchCheck(
        passed: localAgentProcess != nil,
        message: "run-local-agent 기동 확인"
      ),
      AgentLaunchCheck(
        passed: bridgeLauncherProcess != nil,
        message: "run-bridge 기동 확인"
      ),
      AgentLaunchCheck(
        passed: adapterProcess != nil,
        message: "codex-adapter 기동 확인"
      ),
      AgentLaunchCheck(
        passed: wsProcess != nil,
        message: "WS app-server 기동 확인"
      ),
      AgentLaunchCheck(
        passed: localAgentProcess?.command.contains(currentRuntimePath) == true &&
          adapterProcess?.command.contains(currentRuntimePath) == true,
        message: "활성 런타임 경로 기준 서비스 기동 확인"
      ),
      AgentLaunchCheck(
        passed: !adapterPorts.isEmpty,
        message: "브릿지 포트 바인딩 확인"
      ),
      AgentLaunchCheck(
        passed: !wsPorts.isEmpty,
        message: "WS app-server 포트 바인딩 확인"
      ),
      AgentLaunchCheck(
        passed: bridgeHealth?.appServerConnected == true && bridgeHealth?.appServerInitialized == true,
        message: "WS 연결 확인"
      ),
      AgentLaunchCheck(
        passed: bridgeHealth?.ok == true && runtimeState == .running && processId != nil,
        message: "기본 상태 진단 확인"
      )
    ]
  }

  private func listeningTCPPorts(for process: AgentProcessDescriptor) -> [Int] {
    let lsofProcess = Process()
    let output = Pipe()
    lsofProcess.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    lsofProcess.arguments = ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]
    lsofProcess.standardOutput = output
    lsofProcess.standardError = Pipe()

    do {
      try lsofProcess.run()
      lsofProcess.waitUntilExit()
    } catch {
      return []
    }

    guard lsofProcess.terminationStatus == 0 else {
      return []
    }

    let data = output.fileHandleForReading.readDataToEndOfFile()
    let text = String(decoding: data, as: UTF8.self)
    return text
      .split(whereSeparator: \.isNewline)
      .compactMap { line -> Int? in
        guard line.hasPrefix("n"),
              let portComponent = line.split(separator: ":").last,
              let port = Int(portComponent) else {
          return nil
        }
        return port
      }
  }

  private func fetchBridgeHealthStatus(
    host: String,
    port: Int?,
    bridgeToken: String,
    ownerLoginId: String
  ) async -> AgentBridgeHealthStatus? {
    guard let port else {
      return nil
    }

    var components = URLComponents()
    components.scheme = "http"
    components.host = normalizedBridgeProbeHost(host)
    components.port = port
    components.path = "/health"
    components.queryItems = [
      URLQueryItem(name: "user_id", value: ownerLoginId)
    ]

    guard let url = components.url else {
      return nil
    }

    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    request.setValue(bridgeToken, forHTTPHeaderField: "x-bridge-token")

    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let httpResponse = response as? HTTPURLResponse,
            (200..<300).contains(httpResponse.statusCode) else {
        return nil
      }

      return try JSONDecoder().decode(AgentBridgeHealthStatus.self, from: data)
    } catch {
      return nil
    }
  }

  func normalizedBridgeProbeHost(_ host: String) -> String {
    let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
    switch trimmedHost {
    case "", "0.0.0.0", "::", "[::]":
      return "127.0.0.1"
    default:
      return trimmedHost
    }
  }

  private func configuredPortListenersReleased(host: String?, portText: String, isURL: Bool = false) -> Bool {
    let portValue: Int?
    if isURL {
      portValue = URLComponents(string: portText.trimmingCharacters(in: .whitespacesAndNewlines))?.port
    } else {
      portValue = Int(portText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    guard let portValue else {
      return true
    }

    let lsofProcess = Process()
    let output = Pipe()
    lsofProcess.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    lsofProcess.arguments = ["-nP", "-iTCP:\(portValue)", "-sTCP:LISTEN", "-t"]
    lsofProcess.standardOutput = output
    lsofProcess.standardError = Pipe()

    do {
      try lsofProcess.run()
      lsofProcess.waitUntilExit()
    } catch {
      return false
    }

    let data = output.fileHandleForReading.readDataToEndOfFile()
    let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)

    if text.isEmpty {
      return true
    }

    if let host,
       !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
       host != "127.0.0.1",
       host != "localhost" {
      return false
    }

    return false
  }

  private func terminateManagedProcesses(_ processes: [AgentProcessDescriptor]) {
    let processIds = Set(processes.map(\.pid))
    let processGroupIds = Set(processes.map(\.pgid).filter { $0 > 0 })

    for processGroupId in processGroupIds {
      kill(-processGroupId, SIGTERM)
    }

    for processId in processIds where !processGroupIds.contains(processId) {
      kill(processId, SIGTERM)
    }

    let deadline = Date().addingTimeInterval(Double(stopGracePeriodUsec) / 1_000_000.0)

    while Date() < deadline {
      if !processIds.contains(where: { isProcessAlive($0) }) {
        return
      }

      usleep(100_000)
    }

    let aliveProcessIds = processIds.filter { isProcessAlive($0) }
    if !aliveProcessIds.isEmpty {
      let processList = aliveProcessIds.map { String($0) }.joined(separator: ",")
      appendLog("SIGTERM 응답이 없어 런타임 프로세스를 강제 종료합니다. pids=\(processList)")
    }

    for processGroupId in processGroupIds {
      kill(-processGroupId, SIGKILL)
    }

    for processId in aliveProcessIds where !processGroupIds.contains(processId) {
      kill(processId, SIGKILL)
    }
  }

  private func runtimeRootPath() -> String {
    octopAgentMenuAppSupportURL().appendingPathComponent("runtime", isDirectory: true).path
  }

  private func isRuntimeProcessCommand(_ command: String, runtimePath: String, includeAuxiliarySessions: Bool) -> Bool {
    guard command.contains(runtimePath) else {
      return false
    }

    if includeAuxiliarySessions, command.contains("/runtime/bin/codex app-server --listen stdio://") {
      return true
    }

    if includeAuxiliarySessions, command.contains("scripts/login-via-app-server.mjs") {
      return true
    }

    return command.contains("run-local-agent.mjs") ||
      command.contains("run-bridge.mjs") ||
      command.contains("services/codex-adapter/src/index.js") ||
      command.contains("/runtime/bin/codex app-server --listen ws://")
  }

  private struct AgentProcessDescriptor {
    let pid: Int32
    let pgid: Int32
    let command: String
  }

  private struct AgentLaunchCheck {
    let passed: Bool
    let message: String
  }

  private struct AgentBridgeHealthStatus: Decodable {
    let ok: Bool
    let status: Status

    struct Status: Decodable {
      let appServer: AppServerStatus

      enum CodingKeys: String, CodingKey {
        case appServer = "app_server"
      }
    }

    struct AppServerStatus: Decodable {
      let connected: Bool
      let initialized: Bool
    }

    var appServerConnected: Bool {
      status.appServer.connected
    }

    var appServerInitialized: Bool {
      status.appServer.initialized
    }
  }

  private static func makeMenuBarImage(grayscale: Bool) -> NSImage? {
    guard let sourceURL = Bundle.module.url(forResource: "icon", withExtension: "png"),
          let sourceImage = NSImage(contentsOf: sourceURL),
          let tiffData = sourceImage.tiffRepresentation,
          let ciImage = CIImage(data: tiffData) else {
      return nil
    }

    let outputImage: CIImage
    if grayscale {
      let filter = CIFilter.colorControls()
      filter.inputImage = ciImage
      filter.saturation = 0
      filter.brightness = 0
      filter.contrast = 1.05
      outputImage = filter.outputImage ?? ciImage
    } else {
      outputImage = ciImage
    }

    let targetSize = CGSize(width: 18, height: 18)
    let scale = min(targetSize.width / outputImage.extent.width, targetSize.height / outputImage.extent.height)
    let scaledWidth = outputImage.extent.width * scale
    let scaledHeight = outputImage.extent.height * scale
    let translatedX = (targetSize.width - scaledWidth) / 2
    let translatedY = (targetSize.height - scaledHeight) / 2
    let transformed = outputImage
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      .transformed(by: CGAffineTransform(translationX: translatedX, y: translatedY))
    let context = CIContext(options: nil)
    let bounds = CGRect(origin: .zero, size: targetSize)

    guard let cgImage = context.createCGImage(transformed, from: bounds) else {
      return nil
    }

    let image = NSImage(cgImage: cgImage, size: NSSize(width: targetSize.width, height: targetSize.height))
    image.isTemplate = false
    return image
  }
}

@MainActor
struct AgentLogWindow: View {
  @ObservedObject var model: AgentMenuModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label("OctOP Local Agent", systemImage: "terminal")
          .font(.headline)
        Spacer()
        Text(model.runtimeState.rawValue)
          .font(.subheadline)
          .foregroundStyle(statusColor)
      }

      SelectableLogTextView(text: model.lines.joined(separator: "\n"))
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))

      HStack {
        Button("로그 지우기") {
          model.clearLogs()
        }
        Spacer()
        if let updatedAt = model.lastUpdatedAt {
          Text(updatedAt.formatted(date: .omitted, time: .standard))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .padding(16)
    .frame(minWidth: 640, minHeight: 420)
  }

  private var statusColor: Color {
    switch model.runtimeState {
    case .running:
      .green
    case .starting, .stopping:
      .orange
    case .failed:
      .red
    case .stopped:
      .secondary
    }
  }
}

private struct SelectableLogTextView: NSViewRepresentable {
  let text: String

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.borderType = .noBorder
    scrollView.drawsBackground = false

    let textView = NSTextView()
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = false
    textView.importsGraphics = false
    textView.drawsBackground = false
    textView.isHorizontallyResizable = true
    textView.isVerticallyResizable = true
    textView.autoresizingMask = [.width]
    textView.textContainerInset = NSSize(width: 12, height: 12)
    textView.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
    textView.textContainer?.widthTracksTextView = false
    textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)

    scrollView.documentView = textView
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    guard let textView = scrollView.documentView as? NSTextView else {
      return
    }

    let selection = textView.selectedRange()
    textView.string = text

    if selection.location != NSNotFound, NSMaxRange(selection) <= (text as NSString).length {
      textView.setSelectedRange(selection)
    }

    textView.scrollToEndOfDocument(nil)
  }
}

@MainActor
private final class AgentMenuAppInstanceGuard {
  static let shared = AgentMenuAppInstanceGuard()

  let isPrimaryInstance: Bool
  private var lockFileDescriptor: CInt = -1

  private init() {
    isPrimaryInstance = Self.acquireLock(fileDescriptor: &lockFileDescriptor)
  }

  deinit {
    if lockFileDescriptor >= 0 {
      flock(lockFileDescriptor, LOCK_UN)
      close(lockFileDescriptor)
    }
  }

  func activateExistingInstanceIfPossible() {
    guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
      return
    }

    let currentPID = ProcessInfo.processInfo.processIdentifier
    let currentBundlePath = Bundle.main.bundleURL.resolvingSymlinksInPath().path
    let runningApps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)

    let existingApp =
      runningApps.first(where: {
        $0.processIdentifier != currentPID &&
          $0.bundleURL?.resolvingSymlinksInPath().path == currentBundlePath
      }) ??
      runningApps.first(where: { $0.processIdentifier != currentPID })

    existingApp?.activate(options: [])
  }

  private static func acquireLock(fileDescriptor: inout CInt) -> Bool {
    let appSupportURL =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true) ??
      URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/OctOPAgentMenu", isDirectory: true)

    do {
      try FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)
    } catch {
      return true
    }

    let lockURL = appSupportURL.appendingPathComponent("app-instance.lock")
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else {
      return true
    }

    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      close(descriptor)
      return false
    }

    fileDescriptor = descriptor
    return true
  }
}

@MainActor
struct AgentMenuContent: View {
  @ObservedObject var model: AgentMenuModel
  @ObservedObject var bootstrap: AgentBootstrapStore
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("OctOP Local Agent", systemImage: "terminal")
        .font(.headline)

      Text("앱 버전 \(bootstrap.currentAppVersionDisplay)")
        .font(.caption)
        .foregroundStyle(.secondary)

      if let runtimeUpdateStatusDisplay = bootstrap.runtimeUpdateStatusDisplay {
        Text("런타임 ID \(bootstrap.runtimeVersionDisplay) · \(runtimeUpdateStatusDisplay)")
          .font(.caption)
          .foregroundStyle(.blue)
      } else {
        Text("런타임 ID \(bootstrap.runtimeVersionDisplay)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Text(model.runtimeState.rawValue)
        .font(.subheadline)
        .foregroundStyle(statusColor)

      Divider()

      Button(model.isRunning ? "서비스 정지" : "서비스 시작") {
        model.refreshRuntimeStateFromSystem()
        if model.isRunning {
          model.stop()
          Task {
            await bootstrap.refreshAvailableRuntimeUpdate(
              log: model.appendInstallerLog
            )
          }
        } else {
          Task {
            await model.start(using: bootstrap)
            await bootstrap.refreshAvailableRuntimeUpdate(
              log: model.appendInstallerLog
            )
          }
        }
      }
      .disabled(bootstrap.bootstrapInProgress)

      if let availableAppUpdate = bootstrap.availableAppUpdate {
        Button {
          Task { @MainActor in
            model.refreshRuntimeStateFromSystem()
            if model.isRunning {
              model.stop()
              await model.waitUntilStopped()
            }

            _ = await bootstrap.applyAvailableAppUpdate(
              log: model.appendInstallerLog)
          }
        } label: {
          Text(bootstrap.appUpdateInProgress ? "앱 업데이트 중..." : "앱 업데이트 \(availableAppUpdate.tag)")
            .foregroundStyle(.orange)
        }
        .disabled(bootstrap.appUpdateInProgress || bootstrap.bootstrapInProgress)
      }

      Button("환경 설정") {
        openWindowAndActivate(id: "setup")
      }

      Button("종료") {
        model.handleApplicationWillTerminate()
        NSApp.terminate(nil)
      }

      if let lastError = model.lastError, !lastError.isEmpty {
        Divider()
        Text(lastError)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(14)
    .frame(width: 240)
  }

  private func openWindowAndActivate(id: String) {
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.async {
      openWindow(id: id)
    }
  }

  private var statusColor: Color {
    switch model.runtimeState {
    case .running:
      .green
    case .starting, .stopping:
      .orange
    case .failed:
      .red
    case .stopped:
      .secondary
    }
  }
}

@MainActor
final class OctOPAgentMenuAppDelegate: NSObject, NSApplicationDelegate {
  private let instanceGuard = AgentMenuAppInstanceGuard.shared
  var onWillTerminate: (() -> Void)?

  var isPrimaryInstance: Bool {
    instanceGuard.isPrimaryInstance
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard !isPrimaryInstance else {
      return
    }

    instanceGuard.activateExistingInstanceIfPossible()
    DispatchQueue.main.async {
      NSApp.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    guard isPrimaryInstance else {
      return
    }

    onWillTerminate?()
  }

  func applicationShouldSaveApplicationState(_ app: NSApplication) -> Bool {
    false
  }

  func applicationShouldRestoreApplicationState(_ app: NSApplication) -> Bool {
    false
  }
}

@main
@MainActor
struct OctOPAgentMenuApp: App {
  @NSApplicationDelegateAdaptor(OctOPAgentMenuAppDelegate.self) private var appDelegate
  @StateObject private var model = AgentMenuModel()
  @StateObject private var bootstrap = AgentBootstrapStore()
  @State private var appUpdateMonitorTask: Task<Void, Never>? = nil
  @State private var runtimeUpdateMonitorTask: Task<Void, Never>? = nil
  @State private var automaticServiceStartAttempted = false

  init() {
    NSApplication.shared.setActivationPolicy(.accessory)
  }

  var body: some Scene {
    MenuBarExtra {
      AgentMenuContent(model: model, bootstrap: bootstrap)
    } label: {
      Image(nsImage: model.menuBarImage)
        .renderingMode(.original)
        .task {
          guard appDelegate.isPrimaryInstance else {
            return
          }

          appDelegate.onWillTerminate = {
            appUpdateMonitorTask?.cancel()
            appUpdateMonitorTask = nil
            runtimeUpdateMonitorTask?.cancel()
            runtimeUpdateMonitorTask = nil
            Task { @MainActor in
              model.handleApplicationWillTerminate()
            }
          }

          bootstrap.restorePreservedAppDataIfNeeded(log: model.appendInstallerLog)
          bootstrap.markPendingAppUpdateLaunchSucceededIfNeeded(log: model.appendInstallerLog)

          model.refreshRuntimeStateFromSystem()
          await bootstrap.recoverPendingLoginAfterRestart(log: model.appendInstallerLog)
          let readyForLaunch = await bootstrap.ensureReadyForLaunch(log: model.appendInstallerLog)
          model.refreshRuntimeStateFromSystem()

          if
            !automaticServiceStartAttempted &&
            bootstrap.configuration.autoStartAtLogin &&
            readyForLaunch &&
            !model.isRunning
          {
            automaticServiceStartAttempted = true
            model.appendInstallerLog("자동 시작 설정이 켜져 있어 서비스를 시작합니다.")
            await model.start(using: bootstrap)
            model.refreshRuntimeStateFromSystem()
          } else if !automaticServiceStartAttempted {
            automaticServiceStartAttempted = true
          }

          await bootstrap.refreshCodexLoginStatus()
          await bootstrap.refreshAvailableAppUpdate(log: model.appendInstallerLog)
          await bootstrap.refreshAvailableRuntimeUpdate(
            log: model.appendInstallerLog
          )

          if appUpdateMonitorTask == nil {
            appUpdateMonitorTask = Task {
              while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300 * 1_000_000_000)
                guard !Task.isCancelled else {
                  break
                }

                await bootstrap.refreshAvailableAppUpdate(log: model.appendInstallerLog)
              }
            }
          }

          if runtimeUpdateMonitorTask == nil {
            runtimeUpdateMonitorTask = Task {
              while !Task.isCancelled {
                await bootstrap.refreshAvailableRuntimeUpdate(
                  log: model.appendInstallerLog
                )

                let sleepNanoseconds = UInt64(
                  max(bootstrap.runtimeUpdateCheckIntervalSeconds, 5) * 1_000_000_000
                )
                try? await Task.sleep(nanoseconds: sleepNanoseconds)
              }
            }
          }

          bootstrap.cleanupCompletedAppUpdateArtifacts(log: model.appendInstallerLog)
        }
    }

    WindowGroup(id: "logs") {
      AgentLogWindow(model: model)
    }
    .defaultSize(width: 760, height: 520)

    WindowGroup(id: "setup") {
      AgentSetupWindow(
        bootstrap: bootstrap,
        onInstall: { bootstrap.runBootstrap(log: model.appendInstallerLog) },
        onCodexLogin: { authMode, apiKey in
          Task {
            await bootstrap.handleCodexLoginAction(log: model.appendInstallerLog, authMode: authMode, apiKey: apiKey)
          }
        }
      )
    }
    .defaultSize(width: 520, height: 760)
  }
}
