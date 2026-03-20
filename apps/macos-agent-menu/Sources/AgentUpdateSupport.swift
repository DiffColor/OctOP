import AppKit
import Darwin
import Foundation

struct AppUpdateDescriptor: Equatable {
  let tag: String
  let assetName: String
  let downloadURL: URL
}

struct PreparedAppUpdateArtifacts {
  let descriptor: AppUpdateDescriptor
  let updateRootURL: URL
  let archiveURL: URL
  let extractedRootURL: URL
  let updatedAppURL: URL
  let scriptURL: URL
}

@MainActor
extension AgentBootstrapStore {
  var canApplyAppUpdate: Bool {
    if ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_FORCE_ENABLED"] == "1" {
      return true
    }

    return Bundle.main.bundleURL.pathExtension == "app"
  }

  var hasAvailableAppUpdate: Bool {
    canApplyAppUpdate && availableAppUpdate != nil
  }

  var appUpdateScriptAppPID: Int32 {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_PID_OVERRIDE"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       let pid = Int32(overrideValue),
       pid > 0 {
      return pid
    }

    return ProcessInfo.processInfo.processIdentifier
  }

  func refreshAvailableAppUpdate(
    log: @escaping @MainActor (String) -> Void
  ) async {
    guard !appUpdateCheckInProgress else {
      return
    }

    guard canApplyAppUpdate else {
      availableAppUpdate = nil
      lastAppUpdateCheckError = nil
      return
    }

    appUpdateCheckInProgress = true
    defer { appUpdateCheckInProgress = false }

    do {
      let nextAvailableUpdate = try await resolveAvailableAppUpdate()
      availableAppUpdate = nextAvailableUpdate
      lastAppUpdateCheckError = nil

      if let nextAvailableUpdate {
        log("앱 업데이트 가능: \(nextAvailableUpdate.tag)")
      }
    } catch {
      availableAppUpdate = nil
      lastAppUpdateCheckError = error.localizedDescription
      log("앱 업데이트 확인 실패: \(error.localizedDescription)")
    }
  }

  func applyAvailableAppUpdate(
    log: @escaping @MainActor (String) -> Void
  ) async -> Bool {
    guard !appUpdateInProgress else {
      return false
    }

    appUpdateInProgress = true
    defer { appUpdateInProgress = false }

    do {
      guard let preparedUpdate = try await prepareAvailableAppUpdate(log: log) else {
        return false
      }

      try launchReplacementScript(scriptURL: preparedUpdate.scriptURL)
      log("새 버전 \(preparedUpdate.descriptor.tag) 적용을 시작합니다.")
      NSApp.terminate(nil)
      return true
    } catch {
      log("앱 업데이트 실패: \(error.localizedDescription)")
      lastAppUpdateCheckError = error.localizedDescription
      return false
    }
  }

  func prepareAvailableAppUpdate(
    currentAppURL: URL = Bundle.main.bundleURL,
    log: @escaping @MainActor (String) -> Void
  ) async throws -> PreparedAppUpdateArtifacts? {
    let nextAvailableUpdate: AppUpdateDescriptor
    do {
      guard let resolvedRelease = try await resolveAvailableAppUpdate() else {
        availableAppUpdate = nil
        lastAppUpdateCheckError = nil
        log("적용할 앱 업데이트가 없습니다.")
        return nil
      }
      nextAvailableUpdate = resolvedRelease
    } catch {
      log("업데이트 확인 실패: \(error.localizedDescription)")
      lastAppUpdateCheckError = error.localizedDescription
      throw error
    }

    guard currentAppURL.pathExtension == "app" else {
      log("현재 실행 방식에서는 앱 업데이트를 적용할 수 없습니다.")
      return nil
    }

    let updateRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
      .appendingPathComponent("updates", isDirectory: true)
      .appendingPathComponent(nextAvailableUpdate.tag, isDirectory: true)
    let archiveURL = updateRoot.appendingPathComponent(nextAvailableUpdate.assetName)
    let extractedRoot = updateRoot.appendingPathComponent("extracted", isDirectory: true)

    try FileManager.default.createDirectory(at: updateRoot, withIntermediateDirectories: true)

    log("새 버전 \(nextAvailableUpdate.tag)를 다운로드합니다.")
    try await download(from: nextAvailableUpdate.downloadURL, to: archiveURL)

    if FileManager.default.fileExists(atPath: extractedRoot.path) {
      try FileManager.default.removeItem(at: extractedRoot)
    }
    try FileManager.default.createDirectory(at: extractedRoot, withIntermediateDirectories: true)
    try await unzipAppArchive(archiveURL: archiveURL, destinationURL: extractedRoot)

    guard let updatedAppURL = locateUpdatedAppBundle(in: extractedRoot) else {
      log("다운로드한 업데이트에서 앱 번들을 찾지 못했습니다.")
      return nil
    }

    try preserveAppDataForUpdate(
      currentAppURL: currentAppURL,
      targetTag: nextAvailableUpdate.tag,
      log: log
    )
    let scriptURL = updateRoot.appendingPathComponent("apply-update.sh")
    try writeReplacementScript(scriptURL: scriptURL, updatedAppURL: updatedAppURL, currentAppURL: currentAppURL)

    return PreparedAppUpdateArtifacts(
      descriptor: nextAvailableUpdate,
      updateRootURL: updateRoot,
      archiveURL: archiveURL,
      extractedRootURL: extractedRoot,
      updatedAppURL: updatedAppURL,
      scriptURL: scriptURL
    )
  }

  private func resolveAvailableAppUpdate() async throws -> AppUpdateDescriptor? {
    let currentTag = currentAppVersionTag
    guard let currentVersion = MacSemVersion.parse(currentTag) else {
      throw NSError(domain: "OctOPAgentMenu.Update", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "현재 앱 버전을 해석하지 못했습니다: \(currentTag)"
      ])
    }

    guard let latestRelease = try await fetchLatestRelease() else {
      return nil
    }

    guard let latestVersion = MacSemVersion.parse(latestRelease.tag), latestVersion > currentVersion else {
      return nil
    }

    return latestRelease
  }

  private func fetchLatestRelease() async throws -> AppUpdateDescriptor? {
    let arch = currentArchitecture()
    let requestURL = appUpdateTagsFeedURL
    let data = try await loadAppUpdateTagsPayload(from: requestURL)

    let payload = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
    var releases: [(MacSemVersion, AppUpdateDescriptor)] = []

    for item in payload {
      guard let tagName = item["name"] as? String,
            let version = MacSemVersion.parse(tagName) else {
        continue
      }

      let normalizedTag = Self.normalizeVersionTag(tagName)
      let expectedAssetName = expectedAppUpdateAssetName(for: normalizedTag, architecture: arch)
      let downloadURL = appUpdateAssetURL(tag: normalizedTag, assetName: expectedAssetName)

      guard let assetExists = try? await remoteAssetExists(at: downloadURL), assetExists else {
        continue
      }

      releases.append((
        version,
        AppUpdateDescriptor(tag: normalizedTag, assetName: expectedAssetName, downloadURL: downloadURL)
      ))
    }

    return releases.sorted(by: { $0.0 > $1.0 }).first?.1
  }

  var appUpdateTagsFeedURL: URL {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overrideValue.isEmpty,
       let url = URL(string: overrideValue) {
      return url
    }

    return URL(string: "https://api.github.com/repos/DiffColor/OctOP/tags?per_page=30")!
  }

  var appUpdateAssetBaseURL: URL {
    if let overrideValue = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !overrideValue.isEmpty,
       let url = URL(string: overrideValue) {
      return url
    }

    return URL(string: "https://github.com/DiffColor/OctOP/releases/download")!
  }

  func expectedAppUpdateAssetName(for tag: String, architecture: String? = nil) -> String {
    let resolvedArch = architecture ?? currentArchitecture()
    return "OctOPAgentMenu-macos-\(resolvedArch)-\(tag).zip"
  }

  func appUpdateAssetURL(tag: String, assetName: String) -> URL {
    appUpdateAssetBaseURL
      .appendingPathComponent(tag, isDirectory: true)
      .appendingPathComponent(assetName, isDirectory: false)
  }

  private func loadAppUpdateTagsPayload(from requestURL: URL) async throws -> Data {
    if requestURL.isFileURL {
      return try Data(contentsOf: requestURL)
    }

    var request = URLRequest(url: requestURL)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("OctOPAgentMenu/1.0", forHTTPHeaderField: "User-Agent")

    let (data, response) = try await URLSession.shared.data(for: request)
    if let httpResponse = response as? HTTPURLResponse, !(200..<300).contains(httpResponse.statusCode) {
      throw NSError(domain: "OctOPAgentMenu.Update", code: httpResponse.statusCode, userInfo: [
        NSLocalizedDescriptionKey: "릴리즈 조회 실패: HTTP \(httpResponse.statusCode)"
      ])
    }

    return data
  }

  private func remoteAssetExists(at url: URL) async throws -> Bool {
    if url.isFileURL {
      return FileManager.default.fileExists(atPath: url.path)
    }

    var request = URLRequest(url: url)
    request.httpMethod = "HEAD"
    request.setValue("OctOPAgentMenu/1.0", forHTTPHeaderField: "User-Agent")

    let (_, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      return false
    }

    return (200..<400).contains(httpResponse.statusCode)
  }

  private func download(from sourceURL: URL, to destinationURL: URL) async throws {
    if sourceURL.isFileURL {
      if FileManager.default.fileExists(atPath: destinationURL.path) {
        try FileManager.default.removeItem(at: destinationURL)
      }
      try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
      return
    }

    var request = URLRequest(url: sourceURL)
    request.setValue("OctOPAgentMenu/1.0", forHTTPHeaderField: "User-Agent")
    let (temporaryURL, response) = try await URLSession.shared.download(for: request)

    if let httpResponse = response as? HTTPURLResponse, !(200..<300).contains(httpResponse.statusCode) {
      throw NSError(domain: "OctOPAgentMenu.Update", code: httpResponse.statusCode, userInfo: [
        NSLocalizedDescriptionKey: "업데이트 다운로드 실패: HTTP \(httpResponse.statusCode)"
      ])
    }

    if FileManager.default.fileExists(atPath: destinationURL.path) {
      try FileManager.default.removeItem(at: destinationURL)
    }

    try FileManager.default.moveItem(at: temporaryURL, to: destinationURL)
  }

  private func unzipAppArchive(archiveURL: URL, destinationURL: URL) async throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    process.arguments = ["-x", "-k", archiveURL.path, destinationURL.path]
    try await runDetachedProcess(process)
  }

  private func locateUpdatedAppBundle(in extractedRoot: URL) -> URL? {
    let fileManager = FileManager.default
    let enumerator = fileManager.enumerator(
      at: extractedRoot,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    )

    while let nextURL = enumerator?.nextObject() as? URL {
      guard nextURL.pathExtension == "app" else {
        continue
      }

      let bundleExecutableURL = nextURL
        .appendingPathComponent("Contents", isDirectory: true)
        .appendingPathComponent("MacOS", isDirectory: true)
      if fileManager.fileExists(atPath: bundleExecutableURL.path) {
        return nextURL
      }
    }

    return nil
  }

  private func writeReplacementScript(scriptURL: URL, updatedAppURL: URL, currentAppURL: URL) throws {
    let bridgePort = configuration.bridgePort.trimmingCharacters(in: .whitespacesAndNewlines)
    let appServerPort = resolveAppServerPort()
    let runtimePath = runtimeURL.path
    let script = """
    #!/bin/bash
    set -euo pipefail
    APP_PID="\(appUpdateScriptAppPID)"
    CURRENT_APP="\(currentAppURL.path)"
    UPDATED_APP="\(updatedAppURL.path)"
    UPDATE_ROOT="\(scriptURL.deletingLastPathComponent().path)"
    BACKUP_APP="${CURRENT_APP}.previous-update"
    BACKUP_DATA_ROOT="\(appUpdateDataBackupURL.path)"
    LAUNCH_MARKER="${BACKUP_DATA_ROOT}/launch-confirmed"
    SCRIPT_LOG="\(appUpdateScriptLogURL.path)"
    RUNTIME_PATH="\(runtimePath)"
    BRIDGE_PORT="\(bridgePort)"
    APP_SERVER_PORT="\(appServerPort)"

    mkdir -p "$BACKUP_DATA_ROOT"
    : > "$SCRIPT_LOG"

    log() {
      printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$1" >> "$SCRIPT_LOG"
    }

    wait_for_pid_exit() {
      local pid="$1"
      local attempts=0
      while kill -0 "$pid" 2>/dev/null; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
          return 1
        fi
        sleep 1
      done
      return 0
    }

    runtime_process_count() {
      (pgrep -fal "$RUNTIME_PATH" 2>/dev/null || true) | grep -v "/usr/bin/pgrep" | wc -l | tr -d ' '
    }

    wait_for_runtime_processes_exit() {
      local attempts=0
      while true; do
        local count
        count="$(runtime_process_count)"
        if [ "$count" = "0" ]; then
          return 0
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
          return 1
        fi
        sleep 1
      done
    }

    port_listener_count() {
      local port="$1"
      if [ -z "$port" ]; then
        echo "0"
        return 0
      fi
      (lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true) | wc -l | tr -d ' '
    }

    wait_for_port_release() {
      local port="$1"
      local attempts=0
      while true; do
        local count
        count="$(port_listener_count "$port")"
        if [ "$count" = "0" ]; then
          return 0
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
          return 1
        fi
        sleep 1
      done
    }

    restore_previous_bundle() {
      log "이전 앱 번들 복원을 시도합니다."
      rm -rf "$CURRENT_APP"
      if [ -d "$BACKUP_APP" ]; then
        mv "$BACKUP_APP" "$CURRENT_APP"
        open "$CURRENT_APP" || true
        log "이전 앱 번들을 복원하고 실행했습니다."
      else
        log "이전 앱 번들 백업이 없어 복원하지 못했습니다."
      fi
    }

    wait_for_launch_marker() {
      local attempts=0
      while true; do
        if [ -f "$LAUNCH_MARKER" ]; then
          return 0
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
          return 1
        fi
        sleep 1
      done
    }

    if ! wait_for_pid_exit "$APP_PID"; then
      log "기존 앱 PID 종료 대기에 실패했습니다."
      open "$CURRENT_APP" || true
      exit 1
    fi
    log "기존 앱 PID 종료를 확인했습니다."

    if ! wait_for_runtime_processes_exit; then
      log "런타임 프로세스 종료 대기에 실패했습니다."
      open "$CURRENT_APP" || true
      exit 1
    fi
    log "런타임 프로세스 종료를 확인했습니다."

    if ! wait_for_port_release "$BRIDGE_PORT"; then
      log "브릿지 포트 해제 대기에 실패했습니다. port=$BRIDGE_PORT"
      open "$CURRENT_APP" || true
      exit 1
    fi
    log "브릿지 포트 해제를 확인했습니다. port=$BRIDGE_PORT"

    if ! wait_for_port_release "$APP_SERVER_PORT"; then
      log "WS app-server 포트 해제 대기에 실패했습니다. port=$APP_SERVER_PORT"
      open "$CURRENT_APP" || true
      exit 1
    fi
    log "WS app-server 포트 해제를 확인했습니다. port=$APP_SERVER_PORT"

    rm -rf "$BACKUP_APP"
    if [ -d "$CURRENT_APP" ]; then
      mv "$CURRENT_APP" "$BACKUP_APP"
      log "현재 앱 번들을 백업 위치로 이동했습니다."
    fi
    if ! ditto "$UPDATED_APP" "$CURRENT_APP"; then
      log "새 앱 번들 복사에 실패했습니다."
      restore_previous_bundle
      exit 0
    fi
    log "새 앱 번들을 설치 위치에 배치했습니다."

    rm -f "$LAUNCH_MARKER"
    if ! open "$CURRENT_APP"; then
      log "새 앱 번들 실행에 실패했습니다."
      restore_previous_bundle
      exit 0
    fi
    log "새 앱 번들 실행을 요청했습니다."

    if ! wait_for_launch_marker; then
      log "새 앱 launch 확인 마커 대기에 실패했습니다."
      restore_previous_bundle
      exit 0
    fi
    log "새 앱 launch 확인 마커를 감지했습니다."

    rm -rf "$UPDATE_ROOT"
    log "임시 업데이트 폴더를 정리했습니다."
    """

    try script.write(to: scriptURL, atomically: true, encoding: String.Encoding.utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
  }

  private func launchReplacementScript(scriptURL: URL) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [scriptURL.path]
    process.standardOutput = nil
    process.standardError = nil
    try process.run()
  }

  private func runDetachedProcess(_ process: Process) async throws {
    try await withCheckedThrowingContinuation { continuation in
      process.terminationHandler = { completedProcess in
        if completedProcess.terminationReason == .exit, completedProcess.terminationStatus == 0 {
          continuation.resume()
        } else {
          continuation.resume(throwing: NSError(
            domain: "OctOPAgentMenu.Update",
            code: Int(completedProcess.terminationStatus),
            userInfo: [NSLocalizedDescriptionKey: "업데이트 처리 명령 실행 실패"]))
        }
      }

      do {
        try process.run()
      } catch {
        continuation.resume(throwing: error)
      }
    }
  }

  private func currentArchitecture() -> String {
    var uts = utsname()
    uname(&uts)
    let machine = withUnsafePointer(to: &uts.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) {
        String(cString: $0)
      }
    }

    return machine == "x86_64" ? "x86_64" : "arm64"
  }

  private func resolveAppServerPort() -> String {
    let rawValue = configuration.appServerWsUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let components = URLComponents(string: rawValue),
          let port = components.port else {
      return ""
    }

    return String(port)
  }
}

private struct MacSemVersion: Comparable {
  let major: Int
  let minor: Int
  let patch: Int
  let suffix: String?

  static func < (lhs: MacSemVersion, rhs: MacSemVersion) -> Bool {
    if lhs.major != rhs.major {
      return lhs.major < rhs.major
    }

    if lhs.minor != rhs.minor {
      return lhs.minor < rhs.minor
    }

    if lhs.patch != rhs.patch {
      return lhs.patch < rhs.patch
    }

    let lhsStable = lhs.suffix?.isEmpty != false
    let rhsStable = rhs.suffix?.isEmpty != false
    if lhsStable != rhsStable {
      return !lhsStable && rhsStable
    }

    return (lhs.suffix ?? "") < (rhs.suffix ?? "")
  }

  static func parse(_ rawValue: String) -> MacSemVersion? {
    var normalized = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if normalized.hasPrefix("v") {
      normalized.removeFirst()
    }

    normalized = String(normalized.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first ?? Substring(normalized))
    let parts = normalized.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    let numericParts = parts[0].split(separator: ".", omittingEmptySubsequences: false)
    guard numericParts.count >= 3,
          let major = Int(numericParts[0]),
          let minor = Int(numericParts[1]),
          let patch = Int(numericParts[2]) else {
      return nil
    }

    return MacSemVersion(
      major: major,
      minor: minor,
      patch: patch,
      suffix: parts.count > 1 ? String(parts[1]) : nil)
  }
}
