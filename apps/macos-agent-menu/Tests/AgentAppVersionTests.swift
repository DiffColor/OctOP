import XCTest
@testable import OctOPAgentMenu

final class AgentAppVersionTests: XCTestCase {
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
}
