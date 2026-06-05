import Foundation

public struct OAuthAuthorizationSession: Equatable, Sendable {
    public var verifier: String
    public var state: String
    public var authorizationURL: URL

    public init(verifier: String, state: String, authorizationURL: URL) {
        self.verifier = verifier
        self.state = state
        self.authorizationURL = authorizationURL
    }
}

public struct TokenSet: Codable, Equatable, Sendable {
    public var idToken: String
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date

    public init(idToken: String, accessToken: String, refreshToken: String?, expiresAt: Date) {
        self.idToken = idToken
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }

    public var isExpired: Bool {
        Date() >= expiresAt
    }
}

public enum OAuthError: Error, Equatable, LocalizedError {
    case callbackMissingCode
    case stateMismatch
    case invalidTokenResponse

    public var errorDescription: String? {
        switch self {
        case .callbackMissingCode:
            "OAuth callback did not include an authorization code."
        case .stateMismatch:
            "OAuth state mismatch."
        case .invalidTokenResponse:
            "Cognito token endpoint returned an invalid response."
        }
    }
}

public struct CognitoOAuthClient: Sendable {
    public var configuration: AdminConfiguration
    public var urlSession: URLSessionProtocol

    public init(configuration: AdminConfiguration, urlSession: URLSessionProtocol = URLSession.shared) {
        self.configuration = configuration
        self.urlSession = urlSession
    }

    public func makeAuthorizationSession(identityProvider: String? = nil) throws -> OAuthAuthorizationSession {
        let verifier = try PKCE.generateVerifier()
        let state = try PKCE.generateVerifier(length: 32)
        return try makeAuthorizationSession(
            verifier: verifier,
            state: state,
            identityProvider: identityProvider
        )
    }

    public func makeAuthorizationSession(
        verifier: String,
        state: String,
        identityProvider: String? = nil
    ) throws -> OAuthAuthorizationSession {
        var components = URLComponents(url: configuration.authorizeEndpoint, resolvingAgainstBaseURL: false)!
        var queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
            URLQueryItem(name: "scope", value: configuration.scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "code_challenge", value: PKCE.deriveChallenge(verifier: verifier))
        ]
        if let identityProvider, !identityProvider.isEmpty {
            queryItems.append(URLQueryItem(name: "identity_provider", value: identityProvider))
        }
        components.queryItems = queryItems

        guard let authorizationURL = components.url else {
            throw URLValidationError.invalidURL(configuration.authorizeEndpoint.absoluteString)
        }
        return OAuthAuthorizationSession(
            verifier: verifier,
            state: state,
            authorizationURL: authorizationURL
        )
    }

    public func tokenRequest(callbackURL: URL, session: OAuthAuthorizationSession) throws -> URLRequest {
        let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
        let code = components?.queryItems?.first(where: { $0.name == "code" })?.value
        let returnedState = components?.queryItems?.first(where: { $0.name == "state" })?.value

        guard let code, !code.isEmpty else {
            throw OAuthError.callbackMissingCode
        }
        guard returnedState == session.state else {
            throw OAuthError.stateMismatch
        }

        var request = URLRequest(url: configuration.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.httpBody = URLComponents.formURLEncodedBody([
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
            URLQueryItem(name: "code_verifier", value: session.verifier)
        ])
        return request
    }

    public func exchangeCode(callbackURL: URL, session: OAuthAuthorizationSession) async throws -> TokenSet {
        let request = try tokenRequest(callbackURL: callbackURL, session: session)
        let (data, response) = try await urlSession.data(for: request)
        try HTTPResponseValidator.validate(response: response, data: data)
        let decoded = try JSONDecoder().decode(TokenEndpointResponse.self, from: data)
        guard !decoded.idToken.isEmpty, !decoded.accessToken.isEmpty else {
            throw OAuthError.invalidTokenResponse
        }
        return TokenSet(
            idToken: decoded.idToken,
            accessToken: decoded.accessToken,
            refreshToken: decoded.refreshToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expiresIn))
        )
    }

    public func revokeRequest(refreshToken: String) -> URLRequest {
        var request = URLRequest(url: configuration.revokeEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.httpBody = URLComponents.formURLEncodedBody([
            URLQueryItem(name: "token", value: refreshToken),
            URLQueryItem(name: "client_id", value: configuration.clientID)
        ])
        return request
    }

    public func revoke(refreshToken: String) async throws {
        let request = revokeRequest(refreshToken: refreshToken)
        let (data, response) = try await urlSession.data(for: request)
        try HTTPResponseValidator.validate(response: response, data: data)
    }
}

private struct TokenEndpointResponse: Decodable {
    var idToken: String
    var accessToken: String
    var refreshToken: String?
    var expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case idToken = "id_token"
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

private extension URLComponents {
    static func formURLEncodedBody(_ items: [URLQueryItem]) -> Data {
        var components = URLComponents()
        components.queryItems = items
        return Data((components.percentEncodedQuery ?? "").utf8)
    }
}
