import Foundation
import SwiftUI
import TenkaCloudAdminCore

@MainActor
final class AdminSettings: ObservableObject {
    @Published var cognitoDomain: String
    @Published var clientID: String
    @Published var apiBaseURL: String
    @Published var scope: String

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        cognitoDomain = defaults.string(forKey: Keys.cognitoDomain) ?? ""
        clientID = defaults.string(forKey: Keys.clientID) ?? ""
        apiBaseURL = defaults.string(forKey: Keys.apiBaseURL) ?? ""
        scope = defaults.string(forKey: Keys.scope) ?? AdminConfiguration.defaultScope
    }

    var configuration: AdminConfiguration? {
        try? AdminConfiguration(
            cognitoDomain: cognitoDomain,
            clientID: clientID,
            apiBaseURL: apiBaseURL,
            scope: scope
        )
    }

    var validationMessage: String? {
        if cognitoDomain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Cognito domain is required."
        }
        if clientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Cognito client ID is required."
        }
        if apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "API base URL is required."
        }
        if scope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "OAuth scope is required."
        }
        do {
            _ = try AdminConfiguration(
                cognitoDomain: cognitoDomain,
                clientID: clientID,
                apiBaseURL: apiBaseURL,
                scope: scope
            )
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func save() {
        defaults.set(cognitoDomain.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.cognitoDomain)
        defaults.set(clientID.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.clientID)
        defaults.set(apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.apiBaseURL)
        defaults.set(scope.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.scope)
    }
}

private enum Keys {
    static let cognitoDomain = "TenkaCloud.admin.cognitoDomain"
    static let clientID = "TenkaCloud.admin.clientID"
    static let apiBaseURL = "TenkaCloud.admin.apiBaseURL"
    static let scope = "TenkaCloud.admin.scope"
}
