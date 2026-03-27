import Foundation
import XCTest
@testable import OctOPAgentMenu

final class AppBundleUpdateTests: XCTestCase {
  private var sandboxURL: URL!
  private var appSupportURL: URL!
  private var originalAppSupportOverride: String?
  private var originalTagsURLOutput: String?
  private var originalAssetBaseURLOutput: String?
  private var originalAppUpdateForceEnabled: String?
  private var originalAppUpdatePIDOverride: String?

  override func setUpWithError() throws {
    try super.setUpWithError()

    sandboxURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("OctOPAgentMenuAppUpdateTests-\(UUID().uuidString)", isDirectory: true)
    appSupportURL = sandboxURL.appendingPathComponent("AppSupport", isDirectory: true)
    try FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)

    originalAppSupportOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_SUPPORT_PATH"]
    originalTagsURLOutput = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL"]
    originalAssetBaseURLOutput = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL"]
    originalAppUpdateForceEnabled = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_FORCE_ENABLED"]
    originalAppUpdatePIDOverride = ProcessInfo.processInfo.environment["OCTOP_AGENT_MENU_APP_UPDATE_PID_OVERRIDE"]
    setenv("OCTOP_AGENT_MENU_APP_SUPPORT_PATH", appSupportURL.path, 1)
    setenv("OCTOP_AGENT_MENU_APP_UPDATE_FORCE_ENABLED", "1", 1)
  }

  override func tearDownWithError() throws {
    restoreEnvironmentVariable("OCTOP_AGENT_MENU_APP_SUPPORT_PATH", originalValue: originalAppSupportOverride)
    restoreEnvironmentVariable("OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL", originalValue: originalTagsURLOutput)
    restoreEnvironmentVariable("OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL", originalValue: originalAssetBaseURLOutput)
    restoreEnvironmentVariable("OCTOP_AGENT_MENU_APP_UPDATE_FORCE_ENABLED", originalValue: originalAppUpdateForceEnabled)
    restoreEnvironmentVariable("OCTOP_AGENT_MENU_APP_UPDATE_PID_OVERRIDE", originalValue: originalAppUpdatePIDOverride)
    if let sandboxURL {
      try? FileManager.default.removeItem(at: sandboxURL)
    }
    try super.tearDownWithError()
  }

  @MainActor
  func testPreserveBackupWritesStatusAndRestoresMissingAppSupport() throws {
    let bootstrap = AgentBootstrapStore()
    let fakeAppURL = sandboxURL.appendingPathComponent("OctOPAgentMenu.app", isDirectory: true)
    let sampleFileURL = appSupportURL.appendingPathComponent("config.json")
    try "{\"ok\":true}".write(to: sampleFileURL, atomically: true, encoding: .utf8)

    try bootstrap.preserveAppDataForUpdate(
      currentAppURL: fakeAppURL,
      targetTag: "v9.9.9",
      log: { _ in }
    )

    let backupRootURL = URL(fileURLWithPath: appSupportURL.path + ".update-backup", isDirectory: true)
    let backedUpDataURL = backupRootURL.appendingPathComponent(appSupportURL.lastPathComponent, isDirectory: true)
      .appendingPathComponent("config.json")
    let statusURL = backupRootURL.appendingPathComponent("status.json")

    XCTAssertTrue(FileManager.default.fileExists(atPath: backedUpDataURL.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: statusURL.path))

    try FileManager.default.removeItem(at: appSupportURL)
    bootstrap.restorePreservedAppDataIfNeeded(log: { _ in })

    XCTAssertTrue(FileManager.default.fileExists(atPath: sampleFileURL.path))
  }

  @MainActor
  func testPreserveBackupCreatesStatusEvenWithoutExistingAppSupport() throws {
    try FileManager.default.removeItem(at: appSupportURL)
    let bootstrap = AgentBootstrapStore()
    let fakeAppURL = sandboxURL.appendingPathComponent("OctOPAgentMenu.app", isDirectory: true)

    try bootstrap.preserveAppDataForUpdate(
      currentAppURL: fakeAppURL,
      targetTag: "v9.9.9",
      log: { _ in }
    )

    let backupRootURL = URL(fileURLWithPath: appSupportURL.path + ".update-backup", isDirectory: true)
    let statusURL = backupRootURL.appendingPathComponent("status.json")
    let launchMarkerURL = backupRootURL.appendingPathComponent("launch-confirmed")
    let backedUpDataURL = backupRootURL.appendingPathComponent(appSupportURL.lastPathComponent, isDirectory: true)

    XCTAssertTrue(FileManager.default.fileExists(atPath: backupRootURL.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: statusURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: backedUpDataURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: launchMarkerURL.path))
  }

  @MainActor
  func testCleanupWaitsForLaunchConfirmation() throws {
    let bootstrap = AgentBootstrapStore()
    let fakeAppURL = sandboxURL.appendingPathComponent("OctOPAgentMenu.app", isDirectory: true)
    let previousBundleURL = URL(fileURLWithPath: fakeAppURL.path + ".previous-update", isDirectory: true)
    let updateRootURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("OctOPAgentMenu", isDirectory: true)
      .appendingPathComponent("updates", isDirectory: true)
      .appendingPathComponent("v9.9.9", isDirectory: true)

    try FileManager.default.createDirectory(at: previousBundleURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: updateRootURL, withIntermediateDirectories: true)
    try bootstrap.preserveAppDataForUpdate(
      currentAppURL: fakeAppURL,
      targetTag: "v9.9.9",
      log: { _ in }
    )

    let backupRootURL = URL(fileURLWithPath: appSupportURL.path + ".update-backup", isDirectory: true)
    XCTAssertTrue(FileManager.default.fileExists(atPath: backupRootURL.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: previousBundleURL.path))

    bootstrap.cleanupCompletedAppUpdateArtifacts(currentAppURL: fakeAppURL, log: { _ in })

    XCTAssertTrue(FileManager.default.fileExists(atPath: backupRootURL.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: previousBundleURL.path))

    bootstrap.markPendingAppUpdateLaunchSucceededIfNeeded(currentAppURL: fakeAppURL, log: { _ in })
    bootstrap.cleanupCompletedAppUpdateArtifacts(currentAppURL: fakeAppURL, log: { _ in })

    XCTAssertFalse(FileManager.default.fileExists(atPath: backupRootURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: previousBundleURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: updateRootURL.deletingLastPathComponent().path))
  }

  @MainActor
  func testRefreshAvailableAppUpdateDetectsLocalTaggedBundleArtifact() async throws {
    let bootstrap = AgentBootstrapStore()
    let fixture = try makeLocalAppUpdateFixture(tag: "v99.2.5", bootstrap: bootstrap)

    setenv("OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL", fixture.tagsURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL", fixture.assetBaseURL.absoluteString, 1)

    await bootstrap.refreshAvailableAppUpdate(log: { _ in })

    XCTAssertEqual(bootstrap.availableAppUpdate?.tag, "v99.2.5")
    XCTAssertEqual(bootstrap.availableAppUpdate?.assetName, fixture.assetName)
    XCTAssertEqual(bootstrap.availableAppUpdate?.downloadURL, fixture.assetURL)
  }

  @MainActor
  func testRefreshAvailableAppUpdateDetectsCurrentTaggedBundleArtifactName() async throws {
    let bootstrap = AgentBootstrapStore()
    let fixture = try makeLocalAppUpdateFixture(
      tag: "v99.2.6",
      bootstrap: bootstrap,
      assetName: bootstrap.modernAppUpdateAssetName(for: "v99.2.6"),
      launchMarkerURL: nil,
      launchSignalURL: nil
    )

    setenv("OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL", fixture.tagsURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL", fixture.assetBaseURL.absoluteString, 1)

    await bootstrap.refreshAvailableAppUpdate(log: { _ in })

    XCTAssertEqual(bootstrap.availableAppUpdate?.tag, "v99.2.6")
    XCTAssertEqual(bootstrap.availableAppUpdate?.assetName, fixture.assetName)
    XCTAssertEqual(bootstrap.availableAppUpdate?.downloadURL, fixture.assetURL)
  }

  @MainActor
  func testPrepareAvailableAppUpdateStagesLocalTaggedBundleArtifact() async throws {
    let bootstrap = AgentBootstrapStore()
    let fixture = try makeLocalAppUpdateFixture(tag: "v99.2.5", bootstrap: bootstrap)
    let fakeInstalledAppURL = sandboxURL.appendingPathComponent("Installed/OctOPAgentMenu.app", isDirectory: true)
    let sampleFileURL = appSupportURL.appendingPathComponent("config.json")
    try FileManager.default.createDirectory(at: fakeInstalledAppURL, withIntermediateDirectories: true)
    try "{\"ok\":true}".write(to: sampleFileURL, atomically: true, encoding: .utf8)

    setenv("OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL", fixture.tagsURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL", fixture.assetBaseURL.absoluteString, 1)

    let prepared = try await bootstrap.prepareAvailableAppUpdate(
      currentAppURL: fakeInstalledAppURL,
      log: { _ in }
    )

    XCTAssertNotNil(prepared)
    XCTAssertEqual(prepared?.descriptor.tag, "v99.2.5")
    XCTAssertTrue(FileManager.default.fileExists(atPath: prepared?.archiveURL.path ?? ""))
    XCTAssertTrue(FileManager.default.fileExists(atPath: prepared?.updatedAppURL.path ?? ""))
    XCTAssertTrue(FileManager.default.fileExists(atPath: prepared?.scriptURL.path ?? ""))

    let backupRootURL = URL(fileURLWithPath: appSupportURL.path + ".update-backup", isDirectory: true)
    let statusURL = backupRootURL.appendingPathComponent("status.json")
    let scriptContents = try String(contentsOf: prepared!.scriptURL, encoding: .utf8)
    let statusData = try Data(contentsOf: statusURL)
    let pendingState = try JSONSerialization.jsonObject(with: statusData) as? [String: Any]

    XCTAssertEqual(pendingState?["targetTag"] as? String, "v99.2.5")
    XCTAssertEqual(pendingState?["currentAppPath"] as? String, fakeInstalledAppURL.standardizedFileURL.path)
    XCTAssertNil(pendingState?["launchConfirmedAt"] as? String)
    XCTAssertTrue(scriptContents.contains("LAUNCH_MARKER"))
    XCTAssertTrue(scriptContents.contains("BACKUP_APP"))
  }

  @MainActor
  func testPreparedUpdateScriptReplacesBundleAndLaunchesUpdatedApp() async throws {
    let bootstrap = AgentBootstrapStore()
    bootstrap.configuration.bridgePort = "54100"
    bootstrap.configuration.appServerWsUrl = "ws://127.0.0.1:54600"
    let launchSignalURL = sandboxURL.appendingPathComponent("updated-app-launched")
    let fixture = try makeLocalAppUpdateFixture(
      tag: "v99.2.5",
      bootstrap: bootstrap,
      assetName: bootstrap.expectedAppUpdateAssetName(for: "v99.2.5"),
      launchMarkerURL: URL(fileURLWithPath: appSupportURL.path + ".update-backup/launch-confirmed"),
      launchSignalURL: launchSignalURL
    )
    let fakeCurrentAppURL = sandboxURL.appendingPathComponent("Installed/OctOPAgentMenu.app", isDirectory: true)
    try createFakeMacAppBundle(
      at: fakeCurrentAppURL,
      markerFileName: "current-marker.txt",
      markerContents: "current",
      launchMarkerURL: nil,
      launchSignalURL: nil
    )

    setenv("OCTOP_AGENT_MENU_APP_UPDATE_TAGS_URL", fixture.tagsURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_APP_UPDATE_ASSET_BASE_URL", fixture.assetBaseURL.absoluteString, 1)
    setenv("OCTOP_AGENT_MENU_APP_UPDATE_PID_OVERRIDE", "999999", 1)

    let prepared = try await bootstrap.prepareAvailableAppUpdate(
      currentAppURL: fakeCurrentAppURL,
      log: { _ in }
    )
    XCTAssertNotNil(prepared)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [prepared!.scriptURL.path]
    try process.run()
    process.waitUntilExit()
    let scriptLog = (try? String(contentsOf: bootstrap.appUpdateScriptLogURL, encoding: .utf8)) ?? "<missing>"

    XCTAssertEqual(process.terminationStatus, 0, scriptLog)
    XCTAssertTrue(FileManager.default.fileExists(atPath: launchSignalURL.path), scriptLog)
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: fakeCurrentAppURL.appendingPathComponent("Contents/Resources/updated-marker.txt").path
      ),
      scriptLog
    )
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: URL(fileURLWithPath: fakeCurrentAppURL.path + ".previous-update").path
      ),
      scriptLog
    )
  }

  @MainActor
  private func makeLocalAppUpdateFixture(tag: String, bootstrap: AgentBootstrapStore) throws -> (
    tagsURL: URL,
    assetBaseURL: URL,
    assetURL: URL,
    assetName: String
  ) {
    try makeLocalAppUpdateFixture(
      tag: tag,
      bootstrap: bootstrap,
      assetName: bootstrap.expectedAppUpdateAssetName(for: tag),
      launchMarkerURL: nil,
      launchSignalURL: nil
    )
  }

  @MainActor
  private func makeLocalAppUpdateFixture(
    tag: String,
    bootstrap: AgentBootstrapStore,
    assetName: String,
    launchMarkerURL: URL?,
    launchSignalURL: URL?
  ) throws -> (
    tagsURL: URL,
    assetBaseURL: URL,
    assetURL: URL,
    assetName: String
  ) {
    let tagsURL = sandboxURL.appendingPathComponent("tags.json")
    let assetBaseURL = sandboxURL.appendingPathComponent("assets", isDirectory: true)
    let assetDirectoryURL = assetBaseURL.appendingPathComponent(tag, isDirectory: true)
    let appRootURL = sandboxURL.appendingPathComponent("fixture-app/OctOPAgentMenu.app", isDirectory: true)
    let assetURL = assetDirectoryURL.appendingPathComponent(assetName)

    try FileManager.default.createDirectory(at: assetDirectoryURL, withIntermediateDirectories: true)
    try createFakeMacAppBundle(
      at: appRootURL,
      markerFileName: "updated-marker.txt",
      markerContents: "updated",
      launchMarkerURL: launchMarkerURL,
      launchSignalURL: launchSignalURL
    )
    let releasePayload = """
    [{
      "tag_name":"\(tag)",
      "draft":false,
      "prerelease":false,
      "assets":[
        {
          "name":"\(assetName)",
          "browser_download_url":"\(assetURL.absoluteString)"
        }
      ]
    }]
    """
    try Data(releasePayload.utf8).write(to: tagsURL, options: .atomic)
    try zipFixtureAppBundle(appURL: appRootURL, archiveURL: assetURL)

    return (tagsURL, assetBaseURL, assetURL, assetName)
  }

  private func zipFixtureAppBundle(appURL: URL, archiveURL: URL) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    process.arguments = ["-c", "-k", "--sequesterRsrc", "--keepParent", appURL.path, archiveURL.path]
    process.currentDirectoryURL = appURL.deletingLastPathComponent()
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
  }

  private func createFakeMacAppBundle(
    at appURL: URL,
    markerFileName: String,
    markerContents: String,
    launchMarkerURL: URL?,
    launchSignalURL: URL?
  ) throws {
    let contentsURL = appURL.appendingPathComponent("Contents", isDirectory: true)
    let macOSURL = contentsURL.appendingPathComponent("MacOS", isDirectory: true)
    let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
    let executableURL = macOSURL.appendingPathComponent("OctOPAgentMenu")
    let infoPlistURL = contentsURL.appendingPathComponent("Info.plist")
    let markerURL = resourcesURL.appendingPathComponent(markerFileName)

    try FileManager.default.createDirectory(at: macOSURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: resourcesURL, withIntermediateDirectories: true)
    try markerContents.write(to: markerURL, atomically: true, encoding: .utf8)

    let launchMarkerCommand = launchMarkerURL.map {
      "mkdir -p \"\($0.deletingLastPathComponent().path)\"\ntouch \"\($0.path)\""
    } ?? "true"
    let launchSignalCommand = launchSignalURL.map {
      "mkdir -p \"\($0.deletingLastPathComponent().path)\"\ntouch \"\($0.path)\""
    } ?? "true"

    let script = """
    #!/bin/bash
    \(launchMarkerCommand)
    \(launchSignalCommand)
    exit 0
    """

    try script.write(to: executableURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

    let infoPlist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>CFBundleDisplayName</key>
      <string>OctOP</string>
      <key>CFBundleExecutable</key>
      <string>OctOPAgentMenu</string>
      <key>CFBundleIdentifier</key>
      <string>app.diffcolor.octop.agentmenu.test</string>
      <key>CFBundleName</key>
      <string>OctOP</string>
      <key>CFBundlePackageType</key>
      <string>APPL</string>
      <key>CFBundleShortVersionString</key>
      <string>v9.9.9</string>
      <key>CFBundleVersion</key>
      <string>9.9.9</string>
    </dict>
    </plist>
    """
    try infoPlist.write(to: infoPlistURL, atomically: true, encoding: .utf8)
  }

  private func restoreEnvironmentVariable(_ name: String, originalValue: String?) {
    if let originalValue {
      setenv(name, originalValue, 1)
    } else {
      unsetenv(name)
    }
  }
}
