import AppIntents

struct OpenAdminConsoleIntent: AppIntent {
    static let title: LocalizedStringResource = "Open TenkaCloud Admin"
    static let description = IntentDescription("Opens the TenkaCloud native admin console.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

struct TenkaCloudAdminShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenAdminConsoleIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Open TenkaCloud Admin"
            ],
            shortTitle: "Open Admin",
            systemImageName: "person.badge.key"
        )
    }
}
