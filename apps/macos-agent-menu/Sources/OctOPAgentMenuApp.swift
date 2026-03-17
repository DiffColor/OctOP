import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

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

  var repoRootURL: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  func start() {
    guard process == nil else {
      appendLog("local-agent가 이미 실행 중입니다.")
      return
    }

    runtimeState = .starting
    lastError = nil
    appendLog("local-agent 실행을 시작합니다.")

    let nextProcess = Process()
    let stdout = Pipe()
    let stderr = Pipe()

    nextProcess.executableURL = URL(fileURLWithPath: "/bin/zsh")
    nextProcess.arguments = ["-lc", "npm run local-agent:start"]
    nextProcess.currentDirectoryURL = repoRootURL
    nextProcess.standardOutput = stdout
    nextProcess.standardError = stderr
    nextProcess.environment = ProcessInfo.processInfo.environment

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
      appendLog("local-agent가 시작되었습니다. pid=\(nextProcess.processIdentifier)")
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
    guard let process else {
      runtimeState = .stopped
      appendLog("중지할 local-agent 프로세스가 없습니다.")
      return
    }

    runtimeState = .stopping
    lastUpdatedAt = Date()
    appendLog("local-agent 중지를 요청합니다.")

    if process.isRunning {
      process.terminate()
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
        guard let self, let current = self.process, current.isRunning else { return }
        self.appendLog("SIGTERM 응답이 없어 강제 종료합니다.")
        current.interrupt()
      }
    } else {
      handleTermination(process)
    }
  }

  func clearLogs() {
    lines.removeAll(keepingCapacity: true)
    appendLog("로그를 초기화했습니다.")
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

      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 6) {
            ForEach(Array(model.lines.enumerated()), id: \.offset) { index, line in
              Text(line)
                .font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .id(index)
            }
          }
          .padding(12)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .onChange(of: model.lines.count) {
          guard let lastIndex = model.lines.indices.last else { return }
          proxy.scrollTo(lastIndex, anchor: .bottom)
        }
      }

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

struct AgentMenuContent: View {
  @ObservedObject var model: AgentMenuModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("OctOP Local Agent", systemImage: "terminal")
        .font(.headline)

      Text(model.runtimeState.rawValue)
        .font(.subheadline)
        .foregroundStyle(statusColor)

      if let processId = model.processId {
        Text("PID \(processId)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Divider()

      Button(model.isRunning ? "실행 중지" : "실행 시작") {
        if model.isRunning {
          model.stop()
        } else {
          model.start()
        }
      }

      Button("로그 보기") {
        openWindow(id: "logs")
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

@main
struct OctOPAgentMenuApp: App {
  @StateObject private var model = AgentMenuModel()

  init() {
    NSApplication.shared.setActivationPolicy(.accessory)
  }

  var body: some Scene {
    MenuBarExtra {
      AgentMenuContent(model: model)
    } label: {
      Image(nsImage: model.menuBarImage)
        .renderingMode(.original)
    }

    WindowGroup(id: "logs") {
      AgentLogWindow(model: model)
    }
    .defaultSize(width: 760, height: 520)
  }
}
