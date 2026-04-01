import XCTest
@testable import OctOPAgentMenu

final class AgentAppVersionTests: XCTestCase {
  func testCurrentTagPrefersReleaseTagFromBundleInfo() throws {
    let bundleURL = try makeBundle(infoPlist: """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>CFBundleIdentifier</key>
      <string>app.diffcolor.octop.agentmenu.tests</string>
      <key>CFBundleShortVersionString</key>
      <string>1.2.5</string>
      <key>OctOPReleaseTag</key>
      <string>v1.2.5-beta.1</string>
    </dict>
    </plist>
    """)
    let bundle = try XCTUnwrap(Bundle(url: bundleURL))

    XCTAssertEqual(AgentAppVersion.currentTag(bundle: bundle, environment: [:]), "v1.2.5-beta.1")
  }

  func testNormalizeVersionTagAddsPrefixForNumericVersion() {
    XCTAssertEqual(AgentAppVersion.normalizeVersionTag("1.3.0"), "v1.3.0")
  }

  func testNormalizeVersionTagConvertsGitDescribeToSemverCompatibleDevVersion() {
    XCTAssertEqual(
      AgentAppVersion.normalizeVersionTag("v1.3.1-4-g640b52c-dirty"),
      "v1.3.1-dev.4+g640b52c.dirty"
    )
  }

  func testNormalizeVersionTagReturnsNilForUnsupportedValue() {
    XCTAssertNil(AgentAppVersion.normalizeVersionTag("release-candidate"))
  }

  private func makeBundle(infoPlist: String) throws -> URL {
    let bundleURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("AgentAppVersionTests-\(UUID().uuidString)", isDirectory: true)
      .appendingPathComponent("Fixture.bundle", isDirectory: true)

    try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    try infoPlist.write(
      to: bundleURL.appendingPathComponent("Info.plist"),
      atomically: true,
      encoding: .utf8
    )

    addTeardownBlock {
      try? FileManager.default.removeItem(at: bundleURL.deletingLastPathComponent())
    }

    return bundleURL
  }
}
