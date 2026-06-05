import Foundation

public struct AdminConfiguration: Codable, Equatable, Sendable {
    public static let defaultRedirectURI = URL(string: "tenkacloud-admin://auth/callback")!
    public static let defaultScope = "openid email profile"

    public var cognitoDomain: URL
    public var clientID: String
    public var apiBaseURL: URL
    public var redirectURI: URL
    public var scope: String

    public init(
        cognitoDomain: URL,
        clientID: String,
        apiBaseURL: URL,
        redirectURI: URL = Self.defaultRedirectURI,
        scope: String = Self.defaultScope
    ) {
        self.cognitoDomain = cognitoDomain
        self.clientID = clientID
        self.apiBaseURL = apiBaseURL
        self.redirectURI = redirectURI
        self.scope = scope
    }

    public init(
        cognitoDomain: String,
        clientID: String,
        apiBaseURL: String,
        redirectURI: URL = Self.defaultRedirectURI,
        scope: String = Self.defaultScope
    ) throws {
        self.init(
            cognitoDomain: try URLValidation.normalizedCognitoDomain(cognitoDomain),
            clientID: clientID.trimmingCharacters(in: .whitespacesAndNewlines),
            apiBaseURL: try URLValidation.normalizedAPIBaseURL(apiBaseURL),
            redirectURI: redirectURI,
            scope: scope.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    public var authorizeEndpoint: URL {
        cognitoDomain.appendingPathComponent("oauth2/authorize")
    }

    public var tokenEndpoint: URL {
        cognitoDomain.appendingPathComponent("oauth2/token")
    }

    public var revokeEndpoint: URL {
        cognitoDomain.appendingPathComponent("oauth2/revoke")
    }

    public var logoutEndpoint: URL {
        cognitoDomain.appendingPathComponent("logout")
    }

    public var isComplete: Bool {
        !clientID.isEmpty && !scope.isEmpty
    }
}
