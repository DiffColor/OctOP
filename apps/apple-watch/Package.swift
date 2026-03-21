// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "OctOPAppleWatch",
  platforms: [
    .watchOS(.v10)
  ],
  products: [
    .executable(name: "OctOPAppleWatch", targets: ["OctOPAppleWatch"])
  ],
  targets: [
    .executableTarget(
      name: "OctOPAppleWatch",
      path: "Sources/OctOPAppleWatch"
    )
  ]
)
