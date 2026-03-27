import Darwin
import Foundation
import XCTest
@testable import OctOPAgentMenu

final class ServiceRuntimeAtomicUpdateTests: XCTestCase {
  private var sandboxURL: URL!
  private var appSupportURL: URL!
  private var bootstrapSourceURL: URL!
  private var codexAdapterSourceURL: URL!
  private var launchAgentURL: URL!
  private var spawnedProcesses: [Process] = []
  private var originalAppSupportOverride: String?
  private var originalBootstrapOverride: String?
  private var originalCodexAdapterOverride: String?
  private var originalLaunchAgentOverride: String?
  private var originalSkipLoginOverride: String?
  private var originalRuntimeRepoURLOverride: String?
  private var originalRuntimeRepoBranchOverride: String?

  override func setUpWithError() throws {
    try super.setUpWithError()

    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("OctOPAgentMenuTests-\(UUID().uuidString)", isDirectory: true)
    sandboxURL = tempRoot
    appSupportURL = tempRoot.appendingPathComponent("AppSupport", isDirectory: true)
    bootstrapSourceURL = tempRoot.appendingPathComponent("bootstrap", isDirectory: true)
    codexAdapterSourceURL = tempRoot.appendingPathComponent("codex-adapter", isDirectory: true)
    launchAgentURL = tempRoot.appendingPathComponent("LaunchAgents/test.plist")

    try FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)
    try createFakeBootstrapSource(at: bootstrapSourceURL)
    try createFakeCodexAdapterSource(at: codexAdapterSourceURL)

    originalAppSupportOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_SUPPORT_PATH"]
    originalBootstrapOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_BOOTSTRAP_PATH"]
    originalCodexAdapterOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH"]
    originalLaunchAgentOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_LAUNCH_AGENT_PATH"]
    originalSkipLoginOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_SKIP_LOGIN_CHECKS"]
    originalRuntimeRepoURLOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_RUNTIME_REPO_URL"]
    originalRuntimeRepoBranchOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_RUNTIME_REPO_BRANCH"]

    setenv("OCTOP_AGENT_MENU_APP_SUPPORT_PATH", appSupportURL.path, 1)
    setenv("OCTOP_AGENT_MENU_BOOTSTRAP_PATH", bootstrapSourceURL.path, 1)
    setenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH", codexAdapterSourceURL.path, 1)
    setenv("OCTOP_AGENT_MENU_LAUNCH_AGENT_PATH", launchAgentURL.path, 1)
    setenv("OCTOP_AGENT_MENU_SKIP_LOGIN_CHECKS", "1", 1)
  }

  override func tearDownWithError() throws {
    for process in spawnedProcesses {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
    }
    spawnedProcesses.removeAll()

    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_APP_SUPPORT_PATH",
      originalValue: originalAppSupportOverride)
    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_BOOTSTRAP_PATH",
      originalValue: originalBootstrapOverride)
    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH",
      originalValue: originalCodexAdapterOverride)
    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_LAUNCH_AGENT_PATH",
      originalValue: originalLaunchAgentOverride)
    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_SKIP_LOGIN_CHECKS",
      originalValue: originalSkipLoginOverride)
    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_RUNTIME_REPO_URL",
      originalValue: originalRuntimeRepoURLOverride)
    restoreEnvironmentVariable(
      "OCTOP_AGENT_MENU_RUNTIME_REPO_BRANCH",
      originalValue: originalRuntimeRepoBranchOverride)

    if let sandboxURL {
      try? FileManager.default.removeItem(at: sandboxURL)
    }

    try super.tearDownWithError()
  }

  @MainActor
  func testPrepareRuntimeReleaseCreatesAndReusesUnchangedRelease() async throws {
    let bootstrap = makeBootstrap()

    let release1 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    let release2 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })

    XCTAssertEqual(release1.standardizedFileURL, release2.standardizedFileURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: release1.path))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: release1.appendingPathComponent("build-info.json").path
      )
    )

    let releaseNames = try FileManager.default.contentsOfDirectory(
      at: bootstrap.runtimeReleasesURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ).map(\.lastPathComponent)

    XCTAssertEqual(releaseNames.count, 1)
  }

  @MainActor
  func testPrepareRuntimeReleaseCreatesNewReleaseWhenBootstrapChanges() async throws {
    let bootstrap = makeBootstrap()

    let release1 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try overwriteFakeRuntimeFile(
      relativePath: "scripts/run-local-agent.mjs",
      contents: "console.log('changed launcher');\nsetInterval(() => {}, 1000);\n"
    )

    let release2 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })

    XCTAssertNotEqual(release1.standardizedFileURL, release2.standardizedFileURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: release2.path))
  }

  @MainActor
  func testPrepareRuntimeReleaseCreatesNewReleaseWhenCodexAdapterChanges() async throws {
    let bootstrap = makeBootstrap()

    let release1 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try overwriteFakeCodexAdapterFile(
      relativePath: "src/index.js",
      contents: "console.log('updated adapter');\nsetInterval(() => {}, 1000);\n"
    )

    let release2 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })

    XCTAssertNotEqual(release1.standardizedFileURL, release2.standardizedFileURL)
    let adapterContents = try String(
      contentsOf: release2.appendingPathComponent("services/codex-adapter/src/index.js"),
      encoding: .utf8
    )
    XCTAssertTrue(adapterContents.contains("updated adapter"))
  }

  @MainActor
  func testActivateRuntimeReleaseUpdatesPointerAndLaunchContext() async throws {
    let bootstrap = makeBootstrap()

    let release1 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    let previous1 = try bootstrap.activateRuntimeRelease(release1, log: { _ in })
    XCTAssertEqual(previous1?.standardizedFileURL, release1.standardizedFileURL)
    XCTAssertEqual(try String(contentsOf: bootstrap.runtimeCurrentReleasePointerURL).trimmingCharacters(in: .whitespacesAndNewlines), release1.path)

    bootstrap.configuration.bridgePort = "4301"
    let release2 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    let previous2 = try bootstrap.activateRuntimeRelease(release2, log: { _ in })

    XCTAssertEqual(previous2?.standardizedFileURL, release1.standardizedFileURL)
    XCTAssertEqual(try String(contentsOf: bootstrap.runtimeCurrentReleasePointerURL).trimmingCharacters(in: .whitespacesAndNewlines), release2.path)
    XCTAssertEqual(try String(contentsOf: bootstrap.runtimePreviousReleasePointerURL).trimmingCharacters(in: .whitespacesAndNewlines), release1.path)

    let launchContext = try bootstrap.makeLaunchContext()
    XCTAssertEqual(launchContext.workspaceURL.standardizedFileURL, release2.standardizedFileURL)
  }

  @MainActor
  func testDangerousBypassSandboxUpdatesAppServerCommandInLaunchContextAndEnvFile() async throws {
    let bootstrap = makeBootstrap()
    bootstrap.configuration.sandboxMode = AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox

    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })
    let launchContext = try bootstrap.makeLaunchContext()
    let environmentText = try String(
      contentsOf: releaseURL.appendingPathComponent(".env.local"),
      encoding: .utf8
    )

    XCTAssertEqual(
      launchContext.environment["OCTOP_CODEX_SANDBOX"],
      AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox
    )
    XCTAssertTrue(
      launchContext.environment["OCTOP_APP_SERVER_COMMAND"]?.contains("--dangerously-bypass-approvals-and-sandbox app-server --listen") == true
    )
    XCTAssertTrue(
      environmentText.contains("OCTOP_CODEX_SANDBOX=\(AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox)")
    )
    XCTAssertTrue(
      environmentText.contains("--dangerously-bypass-approvals-and-sandbox app-server --listen")
    )
  }

  @MainActor
  func testExecutionPolicyOptionLabelsAreUserFriendly() {
    let bootstrap = makeBootstrap()

    XCTAssertEqual(bootstrap.approvalOptionLabel(for: "on-request"), "필요할 때만 승인 요청")
    XCTAssertEqual(bootstrap.approvalOptionLabel(for: "never"), "승인 요청 없이 진행")
    XCTAssertEqual(bootstrap.approvalOptionLabel(for: "untrusted"), "보수적으로 제한")
    XCTAssertEqual(
      bootstrap.sandboxOptionLabel(for: AgentBootstrapConfiguration.dangerouslyBypassApprovalsAndSandbox),
      "승인/샌드박스 완전 우회 (매우 위험)"
    )
    XCTAssertEqual(bootstrap.sandboxOptionLabel(for: "danger-full-access"), "전체 파일 접근")
    XCTAssertEqual(bootstrap.sandboxOptionLabel(for: "workspace-write"), "워크스페이스만 쓰기")
    XCTAssertEqual(bootstrap.sandboxOptionLabel(for: "read-only"), "읽기 전용")
  }

  @MainActor
  func testDisplayedVersionsUseDeclaredAppVersionAndRuntimeCommit() async throws {
    let revision = try initializeGitRepository(at: codexAdapterSourceURL)

    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    XCTAssertEqual(bootstrap.currentAppVersionDisplay, "v1.2.4")
    XCTAssertEqual(bootstrap.runtimeVersionDisplay, String(revision.prefix(12)))

    let buildInfoData = try Data(contentsOf: releaseURL.appendingPathComponent("build-info.json"))
    let buildInfoObject = try XCTUnwrap(
      JSONSerialization.jsonObject(with: buildInfoData) as? [String: Any]
    )
    let runtimeID = try XCTUnwrap(buildInfoObject["runtimeID"] as? String)
    XCTAssertTrue(runtimeID.hasPrefix("runtime-\(String(revision.prefix(12)))-"))
    XCTAssertEqual(buildInfoObject["appVersion"] as? String, "v1.2.4")
    XCTAssertEqual(buildInfoObject["sourceRevision"] as? String, revision)
  }

  @MainActor
  func testRefreshAvailableRuntimeUpdatePublishesRevision() async throws {
    let currentRevision = try initializeGitRepository(at: codexAdapterSourceURL)
    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    let nextRevision = String(repeating: "a", count: 40)
    bootstrap.runtimeUpdateRevisionResolver = { _ in nextRevision }

    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })
    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })

    XCTAssertEqual(bootstrap.availableRuntimeUpdate?.sourceRevision, nextRevision)
    XCTAssertEqual(bootstrap.availableRuntimeUpdate?.currentSourceRevision, currentRevision)
    XCTAssertEqual(bootstrap.runtimeUpdateStatusDisplay, "업데이트 \(String(nextRevision.prefix(12)))")
  }

  @MainActor
  func testRefreshAvailableRuntimeUpdateClearsStateWhenCurrentRevisionMatchesRemote() async throws {
    let currentRevision = try initializeGitRepository(at: codexAdapterSourceURL)
    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    bootstrap.runtimeUpdateRevisionResolver = { _ in currentRevision }
    bootstrap.availableRuntimeUpdate = RuntimeUpdateDescriptor(
      sourceRevision: String(repeating: "b", count: 40),
      currentSourceRevision: currentRevision
    )

    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })

    XCTAssertNil(bootstrap.availableRuntimeUpdate)
  }

  @MainActor
  func testPrepareRuntimeReleaseUsesLastCodexAdapterRevisionInsteadOfRepositoryHead() async throws {
    let repositoryURL = sandboxURL.appendingPathComponent("override-repository", isDirectory: true)
    let adapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)
    try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
    try createFakeCodexAdapterSource(at: adapterURL)
    try "seed\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )

    let adapterRevision = try initializeGitRepository(at: repositoryURL)
    try "unrelated change\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )
    let unrelatedHeadRevision = try commitGitChanges(
      at: repositoryURL,
      message: "docs only"
    )

    setenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH", adapterURL.path, 1)

    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    let buildInfoData = try Data(contentsOf: releaseURL.appendingPathComponent("build-info.json"))
    let buildInfoObject = try XCTUnwrap(
      JSONSerialization.jsonObject(with: buildInfoData) as? [String: Any]
    )
    let runtimeID = try XCTUnwrap(buildInfoObject["runtimeID"] as? String)

    XCTAssertNotEqual(adapterRevision, unrelatedHeadRevision)
    XCTAssertEqual(buildInfoObject["sourceRevision"] as? String, adapterRevision)
    XCTAssertTrue(runtimeID.hasPrefix("runtime-\(String(adapterRevision.prefix(12)))-"))
  }

  @MainActor
  func testRefreshAvailableRuntimeUpdateUsesLastCodexAdapterRevisionInsteadOfRepositoryHead() async throws {
    let repositoryURL = sandboxURL.appendingPathComponent("update-repository", isDirectory: true)
    let adapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)
    try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
    try createFakeCodexAdapterSource(at: adapterURL)
    try "seed\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )

    _ = try initializeGitRepository(at: repositoryURL)
    setenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH", adapterURL.path, 1)

    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    try "export const domain = \"updated-source\";\n".write(
      to: adapterURL.appendingPathComponent("src/domain.js"),
      atomically: true,
      encoding: .utf8
    )
    let adapterRevision = try commitGitChanges(
      at: repositoryURL,
      message: "update adapter"
    )
    try "unrelated head advance\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )
    let unrelatedHeadRevision = try commitGitChanges(
      at: repositoryURL,
      message: "docs only"
    )

    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })

    XCTAssertNotEqual(adapterRevision, unrelatedHeadRevision)
    XCTAssertEqual(bootstrap.availableRuntimeUpdate?.sourceRevision, adapterRevision)
    XCTAssertEqual(bootstrap.runtimeUpdateStatusDisplay, "업데이트 \(String(adapterRevision.prefix(12)))")
  }

  @MainActor
  func testPrepareRuntimeReleaseUsesLastCodexAdapterRevisionFromShallowRuntimeRepositoryCache() async throws {
    let repositoryURL = sandboxURL.appendingPathComponent("remote-repository", isDirectory: true)
    let adapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)
    try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
    try createFakeCodexAdapterSource(at: adapterURL)
    try "seed\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )

    let adapterRevision = try initializeGitRepository(at: repositoryURL)
    try renameGitBranch(at: repositoryURL, name: "main")
    try "docs only\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )
    let unrelatedHeadRevision = try commitGitChanges(
      at: repositoryURL,
      message: "docs only"
    )

    unsetenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH")
    setenv("OCTOP_AGENT_MENU_RUNTIME_REPO_URL", repositoryURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_RUNTIME_REPO_BRANCH", "main", 1)

    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    let buildInfoData = try Data(contentsOf: releaseURL.appendingPathComponent("build-info.json"))
    let buildInfoObject = try XCTUnwrap(
      JSONSerialization.jsonObject(with: buildInfoData) as? [String: Any]
    )
    let runtimeID = try XCTUnwrap(buildInfoObject["runtimeID"] as? String)

    XCTAssertNotEqual(adapterRevision, unrelatedHeadRevision)
    XCTAssertEqual(buildInfoObject["sourceRevision"] as? String, adapterRevision)
    XCTAssertTrue(runtimeID.hasPrefix("runtime-\(String(adapterRevision.prefix(12)))-"))
  }

  @MainActor
  func testRefreshAvailableRuntimeUpdateUsesLastCodexAdapterRevisionFromShallowRuntimeRepositoryCache() async throws {
    let repositoryURL = sandboxURL.appendingPathComponent("remote-update-repository", isDirectory: true)
    let adapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)
    try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
    try createFakeCodexAdapterSource(at: adapterURL)
    try "seed\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )

    _ = try initializeGitRepository(at: repositoryURL)
    try renameGitBranch(at: repositoryURL, name: "main")

    unsetenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH")
    setenv("OCTOP_AGENT_MENU_RUNTIME_REPO_URL", repositoryURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_RUNTIME_REPO_BRANCH", "main", 1)

    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    try "export const domain = \"updated-from-remote\";\n".write(
      to: adapterURL.appendingPathComponent("src/domain.js"),
      atomically: true,
      encoding: .utf8
    )
    let adapterRevision = try commitGitChanges(
      at: repositoryURL,
      message: "update adapter"
    )
    try "remote docs only\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )
    let unrelatedHeadRevision = try commitGitChanges(
      at: repositoryURL,
      message: "docs only"
    )

    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })

    XCTAssertNotEqual(adapterRevision, unrelatedHeadRevision)
    XCTAssertEqual(bootstrap.availableRuntimeUpdate?.sourceRevision, adapterRevision)
    XCTAssertEqual(bootstrap.runtimeUpdateStatusDisplay, "업데이트 \(String(adapterRevision.prefix(12)))")
  }

  @MainActor
  func testRefreshAvailableRuntimeUpdateFollowsRemoteBranchAfterNonFastForwardRewrite() async throws {
    let repositoryURL = sandboxURL.appendingPathComponent("remote-rewrite-repository", isDirectory: true)
    let adapterURL = repositoryURL
      .appendingPathComponent("services", isDirectory: true)
      .appendingPathComponent("codex-adapter", isDirectory: true)
    try FileManager.default.createDirectory(at: repositoryURL, withIntermediateDirectories: true)
    try createFakeCodexAdapterSource(at: adapterURL)
    try "seed\n".write(
      to: repositoryURL.appendingPathComponent("README.md"),
      atomically: true,
      encoding: .utf8
    )

    let initialRevision = try initializeGitRepository(at: repositoryURL)
    try renameGitBranch(at: repositoryURL, name: "main")

    unsetenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH")
    setenv("OCTOP_AGENT_MENU_RUNTIME_REPO_URL", repositoryURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_RUNTIME_REPO_BRANCH", "main", 1)

    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    try "export const domain = \"rewritten-history\";\n".write(
      to: adapterURL.appendingPathComponent("src/domain.js"),
      atomically: true,
      encoding: .utf8
    )
    let rewrittenRevision = try recreateGitRepository(at: repositoryURL)
    try renameGitBranch(at: repositoryURL, name: "main")

    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })

    XCTAssertNotEqual(initialRevision, rewrittenRevision)
    XCTAssertEqual(bootstrap.availableRuntimeUpdate?.sourceRevision, rewrittenRevision)
    XCTAssertEqual(bootstrap.runtimeUpdateStatusDisplay, "업데이트 \(String(rewrittenRevision.prefix(12)))")
  }

  @MainActor
  func testRefreshAvailableRuntimeUpdateIgnoresRuntimeNodeModulesDifferences() async throws {
    _ = try initializeGitRepository(at: codexAdapterSourceURL)
    let bootstrap = makeBootstrap()
    let releaseURL = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(releaseURL, log: { _ in })

    let installedOnlyFileURL = releaseURL
      .appendingPathComponent("services/codex-adapter/node_modules/local-only/index.js")
    try FileManager.default.createDirectory(
      at: installedOnlyFileURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try "console.log('installed only');\n".write(
      to: installedOnlyFileURL,
      atomically: true,
      encoding: .utf8
    )

    await bootstrap.refreshAvailableRuntimeUpdate(log: { _ in })

    XCTAssertNil(bootstrap.availableRuntimeUpdate)
  }

  @MainActor
  func testServiceStartAndStopUseFreshRuntimeAndStopManagedProcesses() async throws {
    let bootstrap = makeBootstrap()
    let model = AgentMenuModel()

    await model.start(using: bootstrap)
    XCTAssertEqual(model.runtimeState, .running)
    let firstPid = try XCTUnwrap(model.processId)
    XCTAssertTrue(isProcessAlive(firstPid))

    let stdioProcess = try spawnFakeAuxiliaryProcess(
      commandLineSuffix: [
        bootstrap.runtimeBinURL.appendingPathComponent("codex").path,
        "app-server",
        "--listen",
        "stdio://"
      ]
    )

    XCTAssertTrue(waitUntilProcessStarts(processId: stdioProcess.processIdentifier))

    model.stop()
    await model.waitUntilStopped()

    XCTAssertEqual(model.runtimeState, .stopped)
    XCTAssertTrue(waitUntilProcessStops(processId: firstPid))
    XCTAssertTrue(waitUntilProcessStops(processId: stdioProcess.processIdentifier))

    await model.start(using: bootstrap)
    XCTAssertEqual(model.runtimeState, .running)
    let secondPid = try XCTUnwrap(model.processId)
    XCTAssertNotEqual(firstPid, secondPid)

    model.stop()
    await model.waitUntilStopped()
    XCTAssertEqual(model.runtimeState, .stopped)
    XCTAssertTrue(waitUntilProcessStops(processId: secondPid))
  }

  @MainActor
  func testRuntimeStateIgnoresOnlyStdioAuxiliaryProcess() throws {
    let bootstrap = makeBootstrap()
    _ = bootstrap
    let model = AgentMenuModel()

    let stdioProcess = try spawnFakeAuxiliaryProcess(
      commandLineSuffix: [
        bootstrap.runtimeBinURL.appendingPathComponent("codex").path,
        "app-server",
        "--listen",
        "stdio://"
      ]
    )
    XCTAssertTrue(waitUntilProcessStarts(processId: stdioProcess.processIdentifier))

    model.refreshRuntimeStateFromSystem()
    XCTAssertEqual(model.runtimeState, .stopped)
    XCTAssertNil(model.processId)

    model.stop()
    XCTAssertTrue(waitUntilProcessStops(processId: stdioProcess.processIdentifier))
  }

  @MainActor
  func testBridgeProbeHostNormalizationUsesLoopbackForWildcardBindHosts() {
    let model = AgentMenuModel()

    XCTAssertEqual(model.normalizedBridgeProbeHost("0.0.0.0"), "127.0.0.1")
    XCTAssertEqual(model.normalizedBridgeProbeHost("::"), "127.0.0.1")
    XCTAssertEqual(model.normalizedBridgeProbeHost("[::]"), "127.0.0.1")
    XCTAssertEqual(model.normalizedBridgeProbeHost(" localhost "), "localhost")
    XCTAssertEqual(model.normalizedBridgeProbeHost("127.0.0.1"), "127.0.0.1")
  }

  @MainActor
  func testPrepareRuntimeFailureDoesNotChangeActiveRelease() async throws {
    let bootstrap = makeBootstrap()

    let release1 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(release1, log: { _ in })

    try overwriteFakeCodexAdapterFile(
      relativePath: "package.json",
      contents: "{ invalid json"
    )

    do {
      _ = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
      XCTFail("준비 실패가 발생해야 합니다.")
    } catch {
      XCTAssertEqual(
        try String(contentsOf: bootstrap.runtimeCurrentReleasePointerURL).trimmingCharacters(in: .whitespacesAndNewlines),
        release1.path
      )
    }
  }

  @MainActor
  func testStartKeepsCurrentReleaseWhenConfiguredBridgePortIsBusy() async throws {
    let bootstrap = makeBootstrap()
    let model = AgentMenuModel()

    let release1 = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
    try bootstrap.activateRuntimeRelease(release1, log: { _ in })

    let occupiedPortProcess = try spawnExternalPortListener(
      port: Int(bootstrap.configuration.bridgePort) ?? 4100
    )
    XCTAssertTrue(waitUntilProcessStarts(processId: occupiedPortProcess.processIdentifier))

    try overwriteFakeRuntimeFile(
      relativePath: "scripts/run-local-agent.mjs",
      contents: """
      console.log("busy-port runtime");
      setInterval(() => {}, 1000);
      """
    )

    await model.start(using: bootstrap)

    XCTAssertEqual(model.runtimeState, .failed)
    XCTAssertEqual(
      try String(contentsOf: bootstrap.runtimeCurrentReleasePointerURL).trimmingCharacters(in: .whitespacesAndNewlines),
      release1.path
    )

    occupiedPortProcess.terminate()
    occupiedPortProcess.waitUntilExit()
  }

  @MainActor
  func testStartRollsBackToPreviousReleaseWhenNewRuntimeLaunchFails() async throws {
    let bootstrap = makeBootstrap()
    let model = AgentMenuModel()

    await model.start(using: bootstrap)
    XCTAssertEqual(model.runtimeState, .running)
    let release1 = try XCTUnwrap(bootstrap.activeRuntimeReleaseURL)

    model.stop()
    await model.waitUntilStopped()

    try overwriteFakeRuntimeFile(
      relativePath: "scripts/run-local-agent.mjs",
      contents: """
      process.exit(1);
      """
    )

    await model.start(using: bootstrap)

    XCTAssertEqual(model.runtimeState, .running)
    XCTAssertEqual(
      try String(contentsOf: bootstrap.runtimeCurrentReleasePointerURL).trimmingCharacters(in: .whitespacesAndNewlines),
      release1.path
    )
    XCTAssertTrue(model.lines.contains(where: { $0.contains("롤백") }))

    model.stop()
    await model.waitUntilStopped()
  }

  @MainActor
  func testServiceStartSucceedsWhenWsAppServerUsesDangerousBypassFlag() async throws {
    let bootstrap = makeBootstrap()
    let model = AgentMenuModel()

    try overwriteFakeRuntimeFile(
      relativePath: "scripts/run-local-agent.mjs",
      contents: """
      import net from "node:net";
      import { spawn } from "node:child_process";

      const workspaceRoot = process.cwd();
      const wsUrl = new URL(process.env.OCTOP_APP_SERVER_WS_URL);
      const appServerProcess = spawn(
        process.execPath,
        [
          "-e",
          "const net=require('node:net'); const url=new URL(process.argv.at(-1)); const server=net.createServer(); server.listen(Number(url.port), url.hostname); setInterval(() => {}, 1000);",
          `${workspaceRoot}/runtime/bin/codex`,
          "--dangerously-bypass-approvals-and-sandbox",
          "app-server",
          "--listen",
          process.env.OCTOP_APP_SERVER_WS_URL
        ],
        { cwd: workspaceRoot, stdio: "ignore" }
      );
      const bridgeProcess = spawn(process.execPath, ["./scripts/run-bridge.mjs"], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: "ignore"
      });

      function stopAll(signal = "SIGTERM") {
        if (!bridgeProcess.killed) bridgeProcess.kill(signal);
        if (!appServerProcess.killed) appServerProcess.kill(signal);
      }

      appServerProcess.on("exit", () => {
        if (!bridgeProcess.killed) bridgeProcess.kill("SIGTERM");
        process.exit(0);
      });

      bridgeProcess.on("exit", () => {
        if (!appServerProcess.killed) appServerProcess.kill("SIGTERM");
        process.exit(0);
      });

      for (const eventName of ["SIGINT", "SIGTERM"]) {
        process.on(eventName, () => stopAll(eventName));
      }

      setInterval(() => {}, 1000);
      """
    )

    await model.start(using: bootstrap)

    XCTAssertEqual(
      model.runtimeState,
      .running,
      "서비스 시작 로그:\n\(model.lines.joined(separator: "\n"))"
    )

    model.stop()
    await model.waitUntilStopped()
  }

  @MainActor
  func testCleanupStaleRuntimeReleasesKeepsCurrentPreviousAndRecentReleases() async throws {
    let bootstrap = makeBootstrap()
    var releases: [URL] = []

    for index in 0..<5 {
      bootstrap.configuration.bridgePort = String(4100 + index)
      let release = try await bootstrap.prepareRuntimeReleaseForServiceStart(log: { _ in })
      releases.append(release)
      try bootstrap.activateRuntimeRelease(release, log: { _ in })
      usleep(100_000)
    }

    try bootstrap.cleanupStaleRuntimeReleases(log: { _ in })

    let remainingReleaseNames = try FileManager.default.contentsOfDirectory(
      at: bootstrap.runtimeReleasesURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ).map(\.lastPathComponent)

    XCTAssertLessThanOrEqual(remainingReleaseNames.count, 4)
    XCTAssertTrue(remainingReleaseNames.contains(releases[4].lastPathComponent))
    XCTAssertTrue(remainingReleaseNames.contains(releases[3].lastPathComponent))
  }

  @MainActor
  func testApplicationTerminateStopsManagedProcessesAndAuxiliarySessions() async throws {
    let bootstrap = makeBootstrap()
    let model = AgentMenuModel()

    await model.start(using: bootstrap)
    XCTAssertEqual(
      model.runtimeState,
      .running,
      "서비스 시작 로그:\n\(model.lines.joined(separator: "\n"))"
    )
    let servicePid = try XCTUnwrap(
      model.processId,
      "서비스 시작 로그:\n\(model.lines.joined(separator: "\n"))"
    )

    let stdioProcess = try spawnFakeAuxiliaryProcess(
      commandLineSuffix: [
        bootstrap.runtimeBinURL.appendingPathComponent("codex").path,
        "app-server",
        "--listen",
        "stdio://"
      ]
    )
    XCTAssertTrue(waitUntilProcessStarts(processId: stdioProcess.processIdentifier))

    model.handleApplicationWillTerminate()

    XCTAssertTrue(waitUntilProcessStops(processId: servicePid))
    XCTAssertTrue(waitUntilProcessStops(processId: stdioProcess.processIdentifier))
  }

  @MainActor
  func testRealRuntimeUpdateFetchesLatestRemoteCodexAdapterAndSwitchesRelease() async throws {
    guard ProcessInfo.processInfo.environment["OCTOP_RUN_REAL_RUNTIME_UPDATE_TEST"] == "1" else {
      throw XCTSkip("실연결 런타임 업데이트 검증은 요청 시에만 실행합니다.")
    }

    let liveAppSupportURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(
        "Library/Application Support/OctOPAgentMenu",
        isDirectory: true
      )
    let liveCurrentPointerURL = liveAppSupportURL.appendingPathComponent("runtime/current-release.txt")

    guard FileManager.default.fileExists(atPath: liveCurrentPointerURL.path) else {
      throw XCTSkip("실사용 중인 런타임 포인터가 없어 원자적 업데이트 검증을 진행할 수 없습니다.")
    }

    let liveReleasePath = try String(contentsOf: liveCurrentPointerURL, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let liveReleaseURL = URL(fileURLWithPath: liveReleasePath, isDirectory: true)
    let liveAdapterURL = liveReleaseURL.appendingPathComponent("services/codex-adapter/src/index.js")
    let liveAdapterContents = try String(contentsOf: liveAdapterURL, encoding: .utf8)

    XCTAssertFalse(
      liveAdapterContents.contains("Runtime update verification marker"),
      "실사용 런타임이 이미 최신 검증 커밋을 포함하고 있으면 이전 릴리즈 대비 전환 여부를 판별할 수 없습니다."
    )

    let actualBootstrapURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Sources/Resources/bootstrap", isDirectory: true)
      .standardizedFileURL

    setenv("OCTOP_AGENT_MENU_BOOTSTRAP_PATH", actualBootstrapURL.path, 1)
    unsetenv("OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH")
    XCTAssertNil(ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_CODEX_ADAPTER_SOURCE_PATH"])

    let bootstrap = makeBootstrap()
    bootstrap.configuration.bridgeHost = "127.0.0.1"
    bootstrap.configuration.bridgePort = "4310"
    bootstrap.configuration.appServerWsUrl = "ws://127.0.0.1:4610"
    let model = AgentMenuModel()
    let expectedRemoteRevision = try XCTUnwrap(resolveGitRemoteMainRevision())

    try FileManager.default.createDirectory(
      at: bootstrap.runtimeReleasesURL,
      withIntermediateDirectories: true
    )

    let seededReleaseURL = bootstrap.runtimeReleasesURL.appendingPathComponent(
      liveReleaseURL.lastPathComponent,
      isDirectory: true
    )

    if FileManager.default.fileExists(atPath: seededReleaseURL.path) {
      try FileManager.default.removeItem(at: seededReleaseURL)
    }

    try FileManager.default.copyItem(at: liveReleaseURL, to: seededReleaseURL)
    try seededReleaseURL.path.write(
      to: bootstrap.runtimeCurrentReleasePointerURL,
      atomically: true,
      encoding: .utf8
    )

    await model.start(using: bootstrap)

    let repositoryCacheURL = bootstrap.runtimeURL
      .appendingPathComponent("source-cache", isDirectory: true)
      .appendingPathComponent("octop-repo", isDirectory: true)
    let repositoryHead = gitRevision(at: repositoryCacheURL)

    XCTAssertEqual(
      model.runtimeState,
      .running,
      """
      서비스 시작 로그:
      \(model.lines.joined(separator: "\n"))
      repo cache head: \(repositoryHead ?? "nil")
      """
    )

    let switchedReleasePath = try String(
      contentsOf: bootstrap.runtimeCurrentReleasePointerURL,
      encoding: .utf8
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let switchedReleaseURL = URL(fileURLWithPath: switchedReleasePath, isDirectory: true)
    let switchedAdapterContents = try String(
      contentsOf: switchedReleaseURL.appendingPathComponent("services/codex-adapter/src/index.js"),
      encoding: .utf8
    )
    let buildInfoData = try Data(
      contentsOf: switchedReleaseURL.appendingPathComponent("build-info.json")
    )
    let buildInfoObject = try XCTUnwrap(
      JSONSerialization.jsonObject(with: buildInfoData) as? [String: Any]
    )
    let sourceRevision = buildInfoObject["sourceRevision"] as? String

    XCTAssertNotEqual(switchedReleaseURL.standardizedFileURL, seededReleaseURL.standardizedFileURL)
    XCTAssertTrue(
      switchedAdapterContents.contains("Runtime update verification marker"),
      """
      서비스 시작 로그:
      \(model.lines.joined(separator: "\n"))
      repo cache head: \(repositoryHead ?? "nil")
      """
    )
    XCTAssertEqual(
      sourceRevision,
      expectedRemoteRevision,
      """
      서비스 시작 로그:
      \(model.lines.joined(separator: "\n"))
      repo cache head: \(repositoryHead ?? "nil")
      """
    )

    model.stop()
    await model.waitUntilStopped()
  }

  @MainActor
  private func makeBootstrap() -> AgentBootstrapStore {
    let bootstrap = AgentBootstrapStore()
    bootstrap.configuration.autoStartAtLogin = false
    let portSeed = Int.random(in: 5100...6100)
    bootstrap.configuration.bridgeHost = "127.0.0.1"
    bootstrap.configuration.bridgePort = String(portSeed)
    bootstrap.configuration.appServerWsUrl = "ws://127.0.0.1:\(portSeed + 500)"
    return bootstrap
  }

  private func createFakeBootstrapSource(at rootURL: URL) throws {
    let files: [String: String] = [
      "scripts/run-local-agent.mjs": """
      import net from "node:net";
      import { spawn } from "node:child_process";

      const workspaceRoot = process.cwd();
      const wsUrl = new URL(process.env.OCTOP_APP_SERVER_WS_URL);
      const appServerProcess = spawn(
        process.execPath,
        [
          "-e",
          "const net=require('node:net'); const url=new URL(process.argv.at(-1)); const server=net.createServer(); server.listen(Number(url.port), url.hostname); setInterval(() => {}, 1000);",
          `${workspaceRoot}/runtime/bin/codex`,
          "app-server",
          "--listen",
          process.env.OCTOP_APP_SERVER_WS_URL
        ],
        { cwd: workspaceRoot, stdio: "ignore" }
      );
      const bridgeProcess = spawn(process.execPath, ["./scripts/run-bridge.mjs"], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: "ignore"
      });

      function stopAll(signal = "SIGTERM") {
        if (!bridgeProcess.killed) bridgeProcess.kill(signal);
        if (!appServerProcess.killed) appServerProcess.kill(signal);
      }

      appServerProcess.on("exit", () => {
        if (!bridgeProcess.killed) bridgeProcess.kill("SIGTERM");
        process.exit(0);
      });

      bridgeProcess.on("exit", () => {
        if (!appServerProcess.killed) appServerProcess.kill("SIGTERM");
        process.exit(0);
      });

      for (const eventName of ["SIGINT", "SIGTERM"]) {
        process.on(eventName, () => stopAll(eventName));
      }

      setInterval(() => {}, 1000);
      """,
      "scripts/run-bridge.mjs": """
      import { spawn } from "node:child_process";
      import { resolve } from "node:path";

      const workspaceRoot = process.cwd();
      const bridgeEntry = resolve(workspaceRoot, "services/codex-adapter/src/index.js");
      const bridgeProcess = spawn(process.execPath, [bridgeEntry], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: "ignore"
      });

      bridgeProcess.on("exit", () => process.exit(0));
      for (const eventName of ["SIGINT", "SIGTERM"]) {
        process.on(eventName, () => {
          if (!bridgeProcess.killed) {
            bridgeProcess.kill(eventName);
          }
        });
      }

      setInterval(() => {}, 1000);
      """,
      "scripts/shared-env.mjs": """
      export function loadOctopEnv() { return process.env; }
      export function applyBridgeCliArgs(env) { return env; }
      export async function resolveBridgeRuntimeEnv(env) { return env; }
      """,
      "scripts/local-agent-health.mjs": """
      export function evaluateBridgeAppServerRecovery() {
        return {
          usable: true,
          healthy: true,
          recoverable: false,
          nextConsecutiveFailures: 0,
          shouldRestart: false,
          reason: "",
          summary: "healthy"
        };
      }
      """,
      "scripts/login-via-app-server.mjs": """
      console.log(JSON.stringify({ event: "loginComplete", loggedIn: true, summary: "logged-in" }));
      """,
      "services/codex-adapter/package.json": """
      {
        "name": "codex-adapter",
        "private": true,
        "type": "module",
        "version": "1.0.0"
      }
      """,
      "services/codex-adapter/src/index.js": """
      import { createServer } from "node:http";
      const server = createServer((request, response) => {
        if (request.url?.startsWith("/health")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            ok: true,
            status: {
              app_server: {
                connected: true,
                initialized: true
              }
            }
          }));
          return;
        }

        response.writeHead(404);
        response.end();
      });
      server.listen(Number(process.env.OCTOP_BRIDGE_PORT), process.env.OCTOP_BRIDGE_HOST);
      setInterval(() => {}, 1000);
      """,
      "services/codex-adapter/src/domain.js": """
      export const domain = "test";
      """
    ]

    for (relativePath, contents) in files {
      let fileURL = rootURL.appendingPathComponent(relativePath)
      try FileManager.default.createDirectory(
        at: fileURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try contents.write(to: fileURL, atomically: true, encoding: .utf8)
    }
  }

  private func createFakeCodexAdapterSource(at rootURL: URL) throws {
    let files: [String: String] = [
      "package.json": """
      {
        "name": "codex-adapter",
        "private": true,
        "type": "module",
        "version": "1.0.0"
      }
      """,
      "package-lock.json": """
      {
        "name": "codex-adapter",
        "lockfileVersion": 3,
        "requires": true,
        "packages": {
          "": {
            "name": "codex-adapter",
            "version": "1.0.0"
          }
        }
      }
      """,
      "src/index.js": """
      import { createServer } from "node:http";
      const server = createServer((request, response) => {
        if (request.url?.startsWith("/health")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            ok: true,
            status: {
              app_server: {
                connected: true,
                initialized: true
              }
            }
          }));
          return;
        }

        response.writeHead(404);
        response.end();
      });
      server.listen(Number(process.env.OCTOP_BRIDGE_PORT), process.env.OCTOP_BRIDGE_HOST);
      setInterval(() => {}, 1000);
      """,
      "src/domain.js": """
      export const domain = "test-source";
      """
    ]

    for (relativePath, contents) in files {
      let fileURL = rootURL.appendingPathComponent(relativePath)
      try FileManager.default.createDirectory(
        at: fileURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try contents.write(to: fileURL, atomically: true, encoding: .utf8)
    }
  }

  private func overwriteFakeRuntimeFile(relativePath: String, contents: String) throws {
    let fileURL = bootstrapSourceURL.appendingPathComponent(relativePath)
    try contents.write(to: fileURL, atomically: true, encoding: .utf8)
  }

  private func overwriteFakeCodexAdapterFile(relativePath: String, contents: String) throws {
    let fileURL = codexAdapterSourceURL.appendingPathComponent(relativePath)
    try contents.write(to: fileURL, atomically: true, encoding: .utf8)
  }

  @discardableResult
  private func spawnExternalPortListener(port: Int) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = ["-m", "http.server", String(port), "--bind", "127.0.0.1"]
    process.currentDirectoryURL = sandboxURL
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()
    spawnedProcesses.append(process)
    return process
  }

  @discardableResult
  private func spawnFakeAuxiliaryProcess(commandLineSuffix: [String]) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", "while true; do sleep 1; done"] + commandLineSuffix
    process.currentDirectoryURL = sandboxURL
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()
    spawnedProcesses.append(process)
    return process
  }

  private func waitUntilProcessStarts(processId: Int32, timeout: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if isProcessAlive(processId) {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return false
  }

  private func waitUntilProcessStops(processId: Int32, timeout: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if !isProcessAlive(processId) {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return !isProcessAlive(processId)
  }

  private func isProcessAlive(_ processId: Int32) -> Bool {
    if kill(processId, 0) == 0 {
      return true
    }
    return errno == EPERM
  }

  private func restoreEnvironmentVariable(_ name: String, originalValue: String?) {
    if let originalValue {
      setenv(name, originalValue, 1)
    } else {
      unsetenv(name)
    }
  }

  private func gitRevision(at repositoryURL: URL) -> String? {
    guard FileManager.default.fileExists(atPath: repositoryURL.appendingPathComponent(".git").path) else {
      return nil
    }

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

  private func resolveGitRemoteMainRevision() -> String? {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["ls-remote", "https://github.com/DiffColor/OctOP.git", "refs/heads/main"]
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

    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let revision = text.split(separator: "\t").first.map(String.init) ?? ""
    return revision.isEmpty ? nil : revision
  }

  private func initializeGitRepository(at repositoryURL: URL) throws -> String {
    let commands: [[String]] = [
      ["init"],
      ["config", "user.name", "OctOP Tests"],
      ["config", "user.email", "octop-tests@example.com"],
      ["add", "."],
      ["commit", "-m", "seed codex adapter"]
    ]

    for arguments in commands {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
      process.arguments = ["-C", repositoryURL.path] + arguments
      process.standardOutput = Pipe()
      process.standardError = Pipe()
      try process.run()
      process.waitUntilExit()
      XCTAssertEqual(process.terminationStatus, 0, "git command failed: \(arguments.joined(separator: " "))")
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repositoryURL.path, "rev-parse", "HEAD"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = Pipe()
    try process.run()
    process.waitUntilExit()
    let revision = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    XCTAssertEqual(revision.count, 40)
    return revision
  }

  private func commitGitChanges(at repositoryURL: URL, message: String) throws -> String {
    let commands: [[String]] = [
      ["add", "."],
      ["commit", "-m", message]
    ]

    for arguments in commands {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
      process.arguments = ["-C", repositoryURL.path] + arguments
      process.standardOutput = Pipe()
      process.standardError = Pipe()
      try process.run()
      process.waitUntilExit()
      XCTAssertEqual(process.terminationStatus, 0, "git command failed: \(arguments.joined(separator: " "))")
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repositoryURL.path, "rev-parse", "HEAD"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = Pipe()
    try process.run()
    process.waitUntilExit()
    let revision = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    XCTAssertEqual(revision.count, 40)
    return revision
  }

  private func renameGitBranch(at repositoryURL: URL, name: String) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repositoryURL.path, "branch", "-M", name]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0, "git branch rename failed: \(name)")
  }

  private func recreateGitRepository(at repositoryURL: URL) throws -> String {
    let gitDirectoryURL = repositoryURL.appendingPathComponent(".git", isDirectory: true)
    if FileManager.default.fileExists(atPath: gitDirectoryURL.path) {
      try FileManager.default.removeItem(at: gitDirectoryURL)
    }

    return try initializeGitRepository(at: repositoryURL)
  }
}
