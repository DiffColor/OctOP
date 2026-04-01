import Foundation

enum AgentAppVersion {
  static let fallbackVersionTag = "v0.0.0-dev"

  static func currentTag(
    bundle: Bundle = .main,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> String {
    if let bundleTag = normalizeVersionTag(
      (bundle.object(forInfoDictionaryKey: "OctOPReleaseTag") as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    ) {
      return bundleTag
    }

    if let bundleTag = normalizeVersionTag(
      (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    ) {
      return bundleTag
    }

    if let overrideTag = normalizeVersionTag(environment["OCTOP_AGENT_MENU_VERSION"]) {
      return overrideTag
    }

    if let gitDerivedTag = gitDerivedVersionTag(
      currentDirectoryURL: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true),
      executableURL: bundle.executableURL
    ) {
      return gitDerivedTag
    }

    return fallbackVersionTag
  }

  static func normalizeVersionTag(_ rawValue: String?) -> String? {
    guard let rawValue else {
      return nil
    }

    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }

    if let match = trimmed.wholeMatch(of: /^v?(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/) {
      let baseVersion = String(match.1)
      let commitDistance = String(match.2)
      let commitHash = String(match.3)
      let buildMetadata = match.4 == nil ? "g\(commitHash)" : "g\(commitHash).dirty"
      return "v\(baseVersion)-dev.\(commitDistance)+\(buildMetadata)"
    }

    if trimmed.wholeMatch(of: /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/) != nil {
      return trimmed.hasPrefix("v") ? trimmed : "v\(trimmed)"
    }

    if trimmed.wholeMatch(of: /^[0-9a-f]{7,40}$/) != nil {
      return "v0.0.0-dev+\(trimmed)"
    }

    return nil
  }

  private static func gitDerivedVersionTag(
    currentDirectoryURL: URL,
    executableURL: URL?
  ) -> String? {
    for candidateURL in candidateSearchRoots(currentDirectoryURL: currentDirectoryURL, executableURL: executableURL) {
      guard let workspaceURL = findGitWorkspace(startingAt: candidateURL) else {
        continue
      }

      guard let rawDescription = describeGitVersion(in: workspaceURL) else {
        continue
      }

      if let normalizedTag = normalizeVersionTag(rawDescription) {
        return normalizedTag
      }
    }

    return nil
  }

  private static func candidateSearchRoots(
    currentDirectoryURL: URL,
    executableURL: URL?
  ) -> [URL] {
    var candidates: [URL] = [currentDirectoryURL.standardizedFileURL]

    if let executableURL {
      candidates.append(executableURL.deletingLastPathComponent().standardizedFileURL)
    }

    var seenPaths = Set<String>()
    return candidates.filter { candidate in
      let path = candidate.path
      return seenPaths.insert(path).inserted
    }
  }

  private static func findGitWorkspace(startingAt url: URL) -> URL? {
    var currentURL = url.standardizedFileURL
    let fileManager = FileManager.default

    while true {
      let gitURL = currentURL.appendingPathComponent(".git")
      if fileManager.fileExists(atPath: gitURL.path) {
        return currentURL
      }

      let packageURL = currentURL.appendingPathComponent("Package.swift")
      if fileManager.fileExists(atPath: packageURL.path) {
        return currentURL
      }

      let parentURL = currentURL.deletingLastPathComponent()
      if parentURL.path == currentURL.path {
        return nil
      }

      currentURL = parentURL
    }
  }

  private static func describeGitVersion(in workspaceURL: URL) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.currentDirectoryURL = workspaceURL
    process.arguments = [
      "git",
      "describe",
      "--tags",
      "--dirty",
      "--always",
      "--match",
      "v[0-9]*"
    ]

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    guard process.terminationStatus == 0 else {
      return nil
    }

    let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
    guard let rawOutput = String(data: outputData, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !rawOutput.isEmpty else {
      return nil
    }

    return rawOutput
  }
}

func currentAgentMenuVersionTag() -> String {
  AgentAppVersion.currentTag()
}
