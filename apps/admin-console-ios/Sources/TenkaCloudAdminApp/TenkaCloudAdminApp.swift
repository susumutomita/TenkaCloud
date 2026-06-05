import SwiftUI

@main
struct TenkaCloudAdminApp: App {
    @StateObject private var model = AdminAppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
        }
    }
}
