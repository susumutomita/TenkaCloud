// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TenkaCloudAdminIOS",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "TenkaCloudAdminCore", targets: ["TenkaCloudAdminCore"]),
        .executable(name: "TenkaCloudAdminApp", targets: ["TenkaCloudAdminApp"]),
        .executable(name: "TenkaCloudAdminCoreChecks", targets: ["TenkaCloudAdminCoreChecks"])
    ],
    targets: [
        .target(name: "TenkaCloudAdminCore"),
        .executableTarget(
            name: "TenkaCloudAdminApp",
            dependencies: ["TenkaCloudAdminCore"]
        ),
        .executableTarget(
            name: "TenkaCloudAdminCoreChecks",
            dependencies: ["TenkaCloudAdminCore"]
        )
    ]
)
