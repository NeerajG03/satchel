// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Satchel",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Satchel", path: "Sources/Satchel"),
    ]
)
