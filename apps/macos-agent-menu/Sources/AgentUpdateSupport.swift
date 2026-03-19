import AppKit
import Darwin
import Foundation

@MainActor
extension AgentBootstrapStore {
  func applyAppUpdateIfNeeded(
    log: @escaping @MainActor (String) -> Void,
    beforeTermination: (() throws -> Void)? = nil
  ) async -> Bool {
    let currentTag = currentAppVersionTag
    guard let currentVersion = MacSemVersion.parse(currentTag) else {
      log("현재 앱 버전을 해석하지 못했습니다: \(currentTag)")
      return false
    }

    let latestRelease: MacReleaseDescriptor
    do {
      guard let resolvedRelease = try await fetchLatestAvailableRelease() else {
        return false
      }
      latestRelease = resolvedRelease
    } catch {
      log("업데이트 확인 실패: \(error.localizedDescription)")
      return false
    }

    guard let latestVersion = MacSemVersion.parse(latestRelease.tag), latestVersion > currentVersion else {
      log("최신 앱 버전 사용 중: \(currentTag.replacingOccurrences(of: "v", with: ""))")
      return false
    }

    let bundleURL = Bundle.main.bundleURL
    guard bundleURL.pathExtension == "app" else {
      log("새 버전 \(latestRelease.tag)를 확인했지만 현재 실행 방식에서는 앱 본체 자동 업데이트를 적용할 수 없습니다.")
      return false
    }

    let updateRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
      .appendingPathComponent("updates", isDirectory: true)
      .appendingPathComponent(latestRelease.tag, isDirectory: true)

    do {
      try FileManager.default.createDirectory(at: updateRoot, withIntermediateDirectories: true)
      let archiveURL = updateRoot.appendingPathComponent(latestRelease.assetName)
      let extractedRoot = updateRoot.appendingPathComponent("extracted", isDirectory: true)

      log("새 버전 \(latestRelease.tag)를 다운로드합니다.")
      try await download(from: latestRelease.downloadURL, to: archiveURL)

      if FileManager.default.fileExists(atPath: extractedRoot.path) {
        try FileManager.default.removeItem(at: extractedRoot)
      }
      try FileManager.default.createDirectory(at: extractedRoot, withIntermediateDirectories: true)
      try await unzipAppArchive(archiveURL: archiveURL, destinationURL: extractedRoot)

      let updatedAppURL = extractedRoot.appendingPathComponent("OctOPAgentMenu.app", isDirectory: true)
      guard FileManager.default.fileExists(atPath: updatedAppURL.path) else {
        log("다운로드한 업데이트에서 앱 번들을 찾지 못했습니다.")
        return false
      }

      let scriptURL = updateRoot.appendingPathComponent("apply-update.sh")
      try writeReplacementScript(scriptURL: scriptURL, updatedAppURL: updatedAppURL, currentAppURL: bundleURL)
      try beforeTermination?()
      try launchReplacementScript(scriptURL: scriptURL)

      log("새 버전 \(latestRelease.tag) 적용을 시작합니다.")
      NSApp.terminate(nil)
      return true
    } catch {
      log("앱 업데이트 실패: \(error.localizedDescription)")
      return false
    }
  }

  private func fetchLatestAvailableRelease() async throws -> MacReleaseDescriptor? {
    let arch = currentArchitecture()
    let requestURL = URL(string: "https://api.github.com/repos/DiffColor/OctOP/releases?per_page=30")!
    var request = URLRequest(url: requestURL)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("OctOPAgentMenu/1.0", forHTTPHeaderField: "User-Agent")

    let (data, response) = try await URLSession.shared.data(for: request)
    if let httpResponse = response as? HTTPURLResponse, !(200..<300).contains(httpResponse.statusCode) {
      throw NSError(domain: "OctOPAgentMenu.Update", code: httpResponse.statusCode, userInfo: [
        NSLocalizedDescriptionKey: "릴리즈 조회 실패: HTTP \(httpResponse.statusCode)"
      ])
    }

    let payload = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
    let releases = payload.compactMap { item -> (MacSemVersion, MacReleaseDescriptor)? in
      guard let tagName = item["tag_name"] as? String,
            let version = MacSemVersion.parse(tagName),
            let assets = item["assets"] as? [[String: Any]] else {
        return nil
      }

      let normalizedTag = Self.normalizeVersionTag(tagName)
      let expectedAssetName = "OctOPAgentMenu-macos-\(arch)-\(normalizedTag).zip"
      guard let asset = assets.first(where: { ($0["name"] as? String) == expectedAssetName }),
            let assetName = asset["name"] as? String,
            let downloadURLString = asset["browser_download_url"] as? String,
            let downloadURL = URL(string: downloadURLString) else {
        return nil
      }

      return (version, MacReleaseDescriptor(tag: normalizedTag, assetName: assetName, downloadURL: downloadURL))
    }

    return releases.sorted(by: { $0.0 > $1.0 }).first?.1
  }

  private func download(from sourceURL: URL, to destinationURL: URL) async throws {
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

  private func writeReplacementScript(scriptURL: URL, updatedAppURL: URL, currentAppURL: URL) throws {
    let script = """
    #!/bin/bash
    set -euo pipefail
    APP_PID="\(ProcessInfo.processInfo.processIdentifier)"
    CURRENT_APP="\(currentAppURL.path)"
    UPDATED_APP="\(updatedAppURL.path)"
    UPDATE_ROOT="\(scriptURL.deletingLastPathComponent().path)"
    BACKUP_APP="${CURRENT_APP}.previous-update"
    while kill -0 "$APP_PID" 2>/dev/null; do
      sleep 1
    done
    rm -rf "$BACKUP_APP"
    if [ -d "$CURRENT_APP" ]; then
      mv "$CURRENT_APP" "$BACKUP_APP"
    fi
    if ! ditto "$UPDATED_APP" "$CURRENT_APP"; then
      rm -rf "$CURRENT_APP"
      if [ -d "$BACKUP_APP" ]; then
        mv "$BACKUP_APP" "$CURRENT_APP"
      fi
      exit 1
    fi
    rm -rf "$BACKUP_APP"
    open "$CURRENT_APP" || true
    rm -rf "$UPDATE_ROOT"
    """

    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
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
}

private struct MacReleaseDescriptor {
  let tag: String
  let assetName: String
  let downloadURL: URL
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
