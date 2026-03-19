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

  func start(using bootstrap: AgentBootstrapStore) {
    let runtimeProcesses = findRuntimeProcesses()

    if !runtimeProcesses.isEmpty {
      processId = runtimeProcesses.first?.pid
      runtimeState = .running
      lastUpdatedAt = Date()
      appendLog("기존 local-agent 런타임 프로세스를 재사용합니다.")
      return
    }

    guard process == nil else {
      appendLog("local-agent가 이미 실행 중입니다.")
      return
    }

    runtimeState = .starting
    lastError = nil
    appendLog("서비스 시작을 요청합니다.")

    let launchContext: AgentLaunchContext
    do {
      launchContext = try bootstrap.makeLaunchContext()
    } catch {
      runtimeState = .failed
      lastError = error.localizedDescription
      lastUpdatedAt = Date()
      appendLog("local-agent 시작 실패: \(error.localizedDescription)")
      return
    }

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

    do {
      try nextProcess.run()
      process = nextProcess
      stdoutPipe = stdout
      stderrPipe = stderr
      processId = nextProcess.processIdentifier
      runtimeState = .running
      lastUpdatedAt = Date()
      appendLog("서비스가 시작되었습니다. pid=\(nextProcess.processIdentifier)")
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
    if process == nil, let existingProcessId = findExistingAgentProcessId() {
      runtimeState = .stopping
      processId = existingProcessId
      lastUpdatedAt = Date()
      appendLog("기존 local-agent 프로세스 중지를 요청합니다. pid=\(existingProcessId)")
      terminateProcess(existingProcessId)
      return
    }

    if process == nil {
      let staleProcesses = findLingeringRuntimeProcesses()

      if !staleProcesses.isEmpty {
        runtimeState = .stopping
        processId = staleProcesses.first?.pid
        lastUpdatedAt = Date()
        appendLog("잔여 local-agent 런타임 프로세스를 정리합니다.")
        terminateRuntimeProcesses(staleProcesses)
        runtimeState = .stopped
        processId = nil
        lastUpdatedAt = Date()
        appendLog("잔여 local-agent 런타임 프로세스 정리가 완료되었습니다.")
        return
      }

      runtimeState = .stopped
      appendLog("중지할 서비스가 없습니다.")
      return
    }

    guard let process else {
      return
    }

    runtimeState = .stopping
    lastUpdatedAt = Date()
    appendLog("서비스 정지를 요청합니다.")

    if process.isRunning {
      terminateProcess(process.processIdentifier)
    } else {
      handleTermination(process)
    }
  }

  func handleApplicationWillTerminate() {
    if let managedProcess = process, managedProcess.isRunning {
      appendLog("앱 종료에 맞춰 local-agent를 중지합니다.")
      terminateProcess(managedProcess.processIdentifier)
      return
    }

    if let existingProcessId = findExistingAgentProcessId() {
      appendLog("앱 종료에 맞춰 기존 local-agent를 중지합니다. pid=\(existingProcessId)")
      terminateProcess(existingProcessId)
      return
    }

    let staleProcesses = findLingeringRuntimeProcesses()

    if !staleProcesses.isEmpty {
      appendLog("앱 종료에 맞춰 잔여 local-agent 런타임 프로세스를 정리합니다.")
      terminateRuntimeProcesses(staleProcesses)
    }
  }

  func refreshRuntimeStateFromSystem(logDetection: Bool = false) {
    if let managedProcess = process, managedProcess.isRunning {
      processId = managedProcess.processIdentifier
      runtimeState = .running
      lastUpdatedAt = Date()
      return
    }

    let runtimeProcesses = findRuntimeProcesses()

    guard let existingProcessId = findExistingAgentProcessId() ?? runtimeProcesses.first?.pid else {
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
      if runtimeProcesses.contains(where: { $0.pid == existingProcessId && !$0.command.contains("run-local-agent.mjs") }) {
        appendLog("기존 local-agent 런타임 프로세스를 감지했습니다. pid=\(existingProcessId)")
      } else {
        appendLog("기존 local-agent 프로세스를 감지했습니다. pid=\(existingProcessId)")
      }
    }
  }

  func clearLogs() {
    lines.removeAll(keepingCapacity: true)
    appendLog("로그를 초기화했습니다.")
  }

  func appendInstallerLog(_ message: String) {
    appendLog(message)
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

  private func terminateProcess(_ pid: Int32) {
    let runtimeProcesses = findRuntimeProcesses()
    let relatedProcesses = runtimeProcesses.filter { $0.pid == pid || $0.pgid == getpgid(pid) }

    if relatedProcesses.isEmpty {
      kill(pid, SIGTERM)
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
        guard let self else { return }
        guard self.isProcessAlive(pid) else {
          self.runtimeState = .stopped
          self.processId = nil
          self.lastUpdatedAt = Date()
          self.appendLog("local-agent 종료됨. pid=\(pid)")
          return
        }

        self.appendLog("SIGTERM 응답이 없어 강제 종료합니다. pid=\(pid)")
        kill(pid, SIGKILL)
        self.runtimeState = .stopped
        self.processId = nil
        self.lastUpdatedAt = Date()
      }
      return
    }

    terminateRuntimeProcesses(relatedProcesses)
    runtimeState = .stopped
    processId = nil
    lastUpdatedAt = Date()
    appendLog("local-agent 런타임 프로세스가 종료되었습니다. pid=\(pid)")
  }

  private func isProcessAlive(_ pid: Int32) -> Bool {
    if kill(pid, 0) == 0 {
      return true
    }

    return errno == EPERM
  }

  private func findExistingAgentProcessId() -> Int32? {
    findRuntimeProcesses().first(where: { $0.command.contains("run-local-agent.mjs") })?.pid
  }

  private func findLingeringRuntimeProcesses() -> [AgentProcessDescriptor] {
    findRuntimeProcesses().filter { !$0.command.contains("run-local-agent.mjs") }
  }

  private func findRuntimeProcesses() -> [AgentProcessDescriptor] {
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
            isRuntimeProcessCommand(command, runtimePath: runtimePath) else {
        continue
      }

      let pgid = getpgid(pid)
      results.append(AgentProcessDescriptor(pid: pid, pgid: pgid > 0 ? pgid : pid, command: command))
    }

    return results
  }

  private func terminateRuntimeProcesses(_ processes: [AgentProcessDescriptor]) {
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
    let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
      .appendingPathComponent("runtime", isDirectory: true)

    return applicationSupport?.path ?? NSString(string: "~/Library/Application Support/OctOPAgentMenu/runtime").expandingTildeInPath
  }

  private func isRuntimeProcessCommand(_ command: String, runtimePath: String) -> Bool {
    guard command.contains(runtimePath) else {
      return false
    }

    return command.contains("run-local-agent.mjs") ||
      command.contains("run-bridge.mjs") ||
      command.contains("services/codex-adapter/src/index.js") ||
      command.contains("/runtime/bin/codex app-server --listen")
  }

  private struct AgentProcessDescriptor {
    let pid: Int32
    let pgid: Int32
    let command: String
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

      Text("런타임 버전 \(bootstrap.runtimeVersionDisplay)")
        .font(.caption)
        .foregroundStyle(.secondary)

      Text(model.runtimeState.rawValue)
        .font(.subheadline)
        .foregroundStyle(statusColor)

      if let processId = model.processId {
        Text("PID \(processId)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Divider()

      Button(model.isRunning ? "서비스 정지" : "서비스 시작") {
        model.refreshRuntimeStateFromSystem()
        if model.isRunning {
          model.stop()
        } else {
          model.start(using: bootstrap)
        }
      }
      .disabled(bootstrap.bootstrapInProgress)

      Button("재시작") {
        Task { @MainActor in
          model.refreshRuntimeStateFromSystem()
          model.stop()

          if await bootstrap.ensureAppUpdatedIfNeeded(
            log: model.appendInstallerLog,
            force: true,
            startServiceAfterUpdate: true) {
            return
          }

          model.refreshRuntimeStateFromSystem()
          if model.isRunning {
            return
          }

          model.appendInstallerLog("재시작 전에 설치/설정을 마무리합니다.")
          let ready = await bootstrap.ensureReadyForLaunch(log: model.appendInstallerLog)
          model.refreshRuntimeStateFromSystem()
          if ready && !model.isRunning {
            model.start(using: bootstrap)
          } else if !ready {
            model.appendInstallerLog("설치/설정이 완료되지 않아 서비스를 시작하지 않습니다.")
          }
        }
      }
      .disabled(bootstrap.bootstrapInProgress)

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

final class OctOPAgentMenuAppDelegate: NSObject, NSApplicationDelegate {
  var onWillTerminate: (() -> Void)?

  func applicationWillTerminate(_ notification: Notification) {
    onWillTerminate?()
  }
}

@main
@MainActor
struct OctOPAgentMenuApp: App {
  @NSApplicationDelegateAdaptor(OctOPAgentMenuAppDelegate.self) private var appDelegate
  @StateObject private var model = AgentMenuModel()
  @StateObject private var bootstrap = AgentBootstrapStore()

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
          appDelegate.onWillTerminate = {
            Task { @MainActor in
              model.handleApplicationWillTerminate()
            }
          }

          if await bootstrap.ensureAppUpdatedIfNeeded(log: model.appendInstallerLog) {
            return
          }

          model.refreshRuntimeStateFromSystem()
          await bootstrap.ensureInstalledIfNeeded(log: model.appendInstallerLog)

          if bootstrap.consumePendingServiceStartAfterUpdate() {
            model.appendInstallerLog("업데이트 후 서비스 자동 시작을 이어갑니다.")
            let ready = await bootstrap.ensureReadyForLaunch(log: model.appendInstallerLog)
            model.refreshRuntimeStateFromSystem()
            if ready && !model.isRunning {
              model.start(using: bootstrap)
            }
          }
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
        onCodexLogin: {
          Task {
            if bootstrap.codexLoggedIn {
              await bootstrap.reloginCodex(log: model.appendInstallerLog)
            } else {
              await bootstrap.loginCodex(log: model.appendInstallerLog)
            }
          }
        }
      )
    }
    .defaultSize(width: 520, height: 760)
  }
}
