// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "OctOPAgentMenu",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .executable(name: "OctOPAgentMenu", targets: ["OctOPAgentMenu"])
  ],
  targets: [
    .executableTarget(
      name: "OctOPAgentMenu",
      path: "Sources"
    )
  ]
)
