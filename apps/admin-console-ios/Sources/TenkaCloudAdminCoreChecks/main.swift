import Darwin
import Foundation
import TenkaCloudAdminCore

@main
enum CheckRunner {
    static func main() async {
        do {
            try await runAllChecks()
            print("OK TenkaCloudAdminCoreChecks")
        } catch {
            fputs("FAIL \(error)\n", stderr)
            exit(EXIT_FAILURE)
        }
    }
}

private func runAllChecks() async throws {
    try shouldNormalizeCognitoDomainsWithoutScheme()
    try shouldRejectNonCognitoDomains()
    try shouldRejectNonHTTPSAPIURLs()
    try shouldGenerateVerifierWithURLSafeCharacters()
    try shouldDeriveRFC7636Challenge()
    try shouldBuildAuthorizeURLForCognitoCodePKCE()
    try shouldIncludeIdentityProviderWhenSupplied()
    try shouldBuildTokenRequestFromValidCallback()
    try shouldBuildRevokeRequest()
    try shouldRejectCallbacksWithMismatchedState()
    try shouldMapTenantStatusToTones()
    try shouldTreatInactiveTenantsAsDeprovisioned()
    try shouldParseTenantConfigJSON()
    try shouldReturnEmptyParsedConfigForInvalidJSON()
    try shouldCreateTenantsWithSBTInitialStatus()
    try await shouldCallGetTenantsWithIDToken()
    try await shouldAcceptDirectTenantArrays()
    try await shouldSendTenantCreationAsFlatSBTShape()
    try await shouldURLEncodeTenantIDsForDelete()
    try await shouldURLEncodeSlashInTenantIDsForDelete()
    try await shouldSurfaceAPIErrorDetails()
}

private func shouldNormalizeCognitoDomainsWithoutScheme() throws {
    let config = try AdminConfiguration(
        cognitoDomain: "tenkacloud.auth.ap-northeast-1.amazoncognito.com/",
        clientID: "client",
        apiBaseURL: "https://api.example.com/prod/"
    )

    try expectEqual(
        config.cognitoDomain.absoluteString,
        "https://tenkacloud.auth.ap-northeast-1.amazoncognito.com/"
    )
    try expectEqual(config.apiBaseURL.absoluteString, "https://api.example.com/prod")
}

private func shouldRejectNonCognitoDomains() throws {
    try expectThrows(URLValidationError.nonCognitoDomain("https://example.com")) {
        _ = try AdminConfiguration(
            cognitoDomain: "https://example.com",
            clientID: "client",
            apiBaseURL: "https://api.example.com"
        )
    }
}

private func shouldRejectNonHTTPSAPIURLs() throws {
    try expectThrows(URLValidationError.nonHTTPSURL("http://api.example.com")) {
        _ = try AdminConfiguration(
            cognitoDomain: "https://tenkacloud.auth.ap-northeast-1.amazoncognito.com",
            clientID: "client",
            apiBaseURL: "http://api.example.com"
        )
    }
}

private func shouldGenerateVerifierWithURLSafeCharacters() throws {
    let verifier = try PKCE.generateVerifier()

    try expectEqual(verifier.count, 64)
    try expect(
        verifier.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil,
        "Verifier contains only URL-safe characters"
    )
}

private func shouldDeriveRFC7636Challenge() throws {
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"

    let challenge = PKCE.deriveChallenge(verifier: verifier)

    try expectEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
}

private func shouldBuildAuthorizeURLForCognitoCodePKCE() throws {
    let client = CognitoOAuthClient(configuration: try fixtureConfiguration())
    let session = try client.makeAuthorizationSession(verifier: "verifier", state: "state")
    let components = URLComponents(url: session.authorizationURL, resolvingAgainstBaseURL: false)
    let params = Dictionary(
        uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") }
    )

    try expectEqual(components?.scheme, "https")
    try expectEqual(components?.host, "tenkacloud.auth.ap-northeast-1.amazoncognito.com")
    try expectEqual(components?.path, "/oauth2/authorize")
    try expectEqual(params["client_id"], "client")
    try expectEqual(params["response_type"], "code")
    try expectEqual(params["redirect_uri"], "tenkacloud-admin://auth/callback")
    try expectEqual(params["scope"], "openid email profile")
    try expectEqual(params["state"], "state")
    try expectEqual(params["code_challenge_method"], "S256")
    try expectEqual(params["code_challenge"], PKCE.deriveChallenge(verifier: "verifier"))
}

private func shouldIncludeIdentityProviderWhenSupplied() throws {
    let client = CognitoOAuthClient(configuration: try fixtureConfiguration())

    let session = try client.makeAuthorizationSession(
        verifier: "verifier",
        state: "state",
        identityProvider: "ExampleSAML"
    )
    let params = Dictionary(
        uniqueKeysWithValues: (URLComponents(
            url: session.authorizationURL,
            resolvingAgainstBaseURL: false
        )?.queryItems ?? []).map { ($0.name, $0.value ?? "") }
    )

    try expectEqual(params["identity_provider"], "ExampleSAML")
}

private func shouldBuildTokenRequestFromValidCallback() throws {
    let client = CognitoOAuthClient(configuration: try fixtureConfiguration())
    let session = OAuthAuthorizationSession(
        verifier: "verifier",
        state: "state",
        authorizationURL: URL(string: "https://example.com")!
    )

    let request = try client.tokenRequest(
        callbackURL: URL(string: "tenkacloud-admin://auth/callback?code=abc&state=state")!,
        session: session
    )
    let body = String(data: request.httpBody ?? Data(), encoding: .utf8)

    try expectEqual(
        request.url?.absoluteString,
        "https://tenkacloud.auth.ap-northeast-1.amazoncognito.com/oauth2/token"
    )
    try expectEqual(request.httpMethod, "POST")
    try expect(body?.contains("grant_type=authorization_code") == true, "Token body includes grant_type")
    try expect(body?.contains("client_id=client") == true, "Token body includes client_id")
    try expect(body?.contains("code=abc") == true, "Token body includes code")
    try expect(
        body?.contains("redirect_uri=tenkacloud-admin://auth/callback") == true,
        "Token body includes redirect_uri"
    )
    try expect(body?.contains("code_verifier=verifier") == true, "Token body includes code_verifier")
}

private func shouldRejectCallbacksWithMismatchedState() throws {
    let client = CognitoOAuthClient(configuration: try fixtureConfiguration())
    let session = OAuthAuthorizationSession(
        verifier: "verifier",
        state: "expected",
        authorizationURL: URL(string: "https://example.com")!
    )

    try expectThrows(OAuthError.stateMismatch) {
        _ = try client.tokenRequest(
            callbackURL: URL(string: "tenkacloud-admin://auth/callback?code=abc&state=actual")!,
            session: session
        )
    }
}

private func shouldBuildRevokeRequest() throws {
    let client = CognitoOAuthClient(configuration: try fixtureConfiguration())

    let request = client.revokeRequest(refreshToken: "refresh-token")
    let body = String(data: request.httpBody ?? Data(), encoding: .utf8)

    try expectEqual(
        request.url?.absoluteString,
        "https://tenkacloud.auth.ap-northeast-1.amazoncognito.com/oauth2/revoke"
    )
    try expectEqual(request.httpMethod, "POST")
    try expect(body?.contains("token=refresh-token") == true, "Revoke body includes token")
    try expect(body?.contains("client_id=client") == true, "Revoke body includes client_id")
}

private func shouldMapTenantStatusToTones() throws {
    try expectEqual(
        Tenant(tenantId: "t1", tenantName: "A", email: "a@example.com", tier: "basic", tenantStatus: "Complete").statusTone,
        .success
    )
    try expectEqual(
        Tenant(tenantId: "t1", tenantName: "A", email: "a@example.com", tier: "basic", tenantStatus: "In progress").statusTone,
        .inProgress
    )
    try expectEqual(
        Tenant(tenantId: "t1", tenantName: "A", email: "a@example.com", tier: "basic", tenantStatus: "Failed").statusTone,
        .failed
    )
    try expectEqual(
        Tenant(tenantId: "t1", tenantName: "A", email: "a@example.com", tier: "basic", tenantStatus: "Deleted").statusTone,
        .inactive
    )
    try expectEqual(
        Tenant(tenantId: "t1", tenantName: "A", email: "a@example.com", tier: "basic", tenantStatus: "Mystery").statusTone,
        .unknown
    )
}

private func shouldTreatInactiveTenantsAsDeprovisioned() throws {
    let tenant = Tenant(
        tenantId: "t1",
        tenantName: "A",
        email: "a@example.com",
        tier: "basic",
        tenantStatus: "Complete",
        isActive: false
    )

    try expect(tenant.isDeprovisioned, "Inactive tenants are deprovisioned")
    try expectEqual(tenant.statusTone, .inactive)
}

private func shouldParseTenantConfigJSON() throws {
    let raw = """
    {
      "userPoolId": "ap-northeast-1_xxx",
      "appClientId": "client",
      "apiGatewayUrl": "https://api.example.com",
      "applicationAdminConsoleUrl": "https://console.example.com",
      "provisioningBuildId": "proj:abc",
      "provisioningProjectName": "proj",
      "provisioningRegion": "ap-northeast-1",
      "provisioningAccountId": "123456789012"
    }
    """

    let parsed = parseTenantConfig(raw)

    try expectEqual(parsed.userPoolId, "ap-northeast-1_xxx")
    try expectEqual(parsed.appClientId, "client")
    try expectEqual(parsed.apiGatewayUrl, "https://api.example.com")
    try expectEqual(parsed.applicationAdminConsoleUrl, "https://console.example.com")
    try expectEqual(parsed.provisioningBuildId, "proj:abc")
}

private func shouldReturnEmptyParsedConfigForInvalidJSON() throws {
    try expectEqual(parseTenantConfig("not json"), ParsedTenantConfig())
}

private func shouldCreateTenantsWithSBTInitialStatus() throws {
    let request = CreateTenantRequest(
        tenantName: "ACME",
        email: "admin@example.com",
        tier: .platinum
    )

    try expectEqual(request.tenantStatus, "In progress")
}

private func shouldCallGetTenantsWithIDToken() async throws {
    let http = MockURLSession(data: tenantsEnvelopeData(), statusCode: HTTPStatus.ok.rawValue)
    let client = AdminAPIClient(
        baseURL: URL(string: "https://api.example.com/prod")!,
        idToken: "id-token",
        urlSession: http
    )

    let tenants = try await client.listTenants()

    try expectEqual(tenants.map(\.tenantId), ["t1"])
    try expectEqual(http.requests.first?.url?.absoluteString, "https://api.example.com/prod/tenants")
    try expectEqual(http.requests.first?.value(forHTTPHeaderField: "authorization"), "Bearer id-token")
}

private func shouldAcceptDirectTenantArrays() async throws {
    let data = """
    [
      {
        "tenantId": "t1",
        "tenantName": "ACME",
        "email": "admin@example.com",
        "tier": "basic",
        "tenantStatus": "Complete"
      }
    ]
    """.data(using: .utf8)!
    let http = MockURLSession(data: data, statusCode: HTTPStatus.ok.rawValue)
    let client = AdminAPIClient(
        baseURL: URL(string: "https://api.example.com/prod")!,
        idToken: "id-token",
        urlSession: http
    )

    let tenants = try await client.listTenants()

    try expectEqual(tenants.count, 1)
    try expectEqual(tenants[0].tenantName, "ACME")
}

private func shouldSendTenantCreationAsFlatSBTShape() async throws {
    let http = MockURLSession(data: tenantEnvelopeData(), statusCode: HTTPStatus.ok.rawValue)
    let client = AdminAPIClient(
        baseURL: URL(string: "https://api.example.com/prod")!,
        idToken: "id-token",
        urlSession: http
    )

    _ = try await client.createTenant(
        CreateTenantRequest(tenantName: "ACME", email: "admin@example.com", tier: .advanced)
    )
    let body = try unwrap(http.requests.first?.httpBody, "Missing request body")
    let json = try unwrap(
        JSONSerialization.jsonObject(with: body) as? [String: String],
        "Request body was not a string JSON object"
    )

    try expectEqual(http.requests.first?.httpMethod, "POST")
    try expectEqual(http.requests.first?.url?.absoluteString, "https://api.example.com/prod/tenants")
    try expectEqual(json["tenantName"], "ACME")
    try expectEqual(json["email"], "admin@example.com")
    try expectEqual(json["tier"], "advanced")
    try expectEqual(json["tenantStatus"], "In progress")
}

private func shouldURLEncodeTenantIDsForDelete() async throws {
    let http = MockURLSession(data: Data(), statusCode: HTTPStatus.noContent.rawValue)
    let client = AdminAPIClient(
        baseURL: URL(string: "https://api.example.com/prod")!,
        idToken: "id-token",
        urlSession: http
    )

    try await client.deleteTenant(tenantId: "tenant with space")

    try expectEqual(http.requests.first?.httpMethod, "DELETE")
    try expectEqual(
        http.requests.first?.url?.absoluteString,
        "https://api.example.com/prod/tenants/tenant%20with%20space"
    )
}

private func shouldURLEncodeSlashInTenantIDsForDelete() async throws {
    let http = MockURLSession(data: Data(), statusCode: HTTPStatus.noContent.rawValue)
    let client = AdminAPIClient(
        baseURL: URL(string: "https://api.example.com/prod")!,
        idToken: "id-token",
        urlSession: http
    )

    try await client.deleteTenant(tenantId: "tenant/with/slash")

    try expectEqual(http.requests.first?.httpMethod, "DELETE")
    try expectEqual(
        http.requests.first?.url?.absoluteString,
        "https://api.example.com/prod/tenants/tenant%2Fwith%2Fslash"
    )
}

private func shouldSurfaceAPIErrorDetails() async throws {
    let http = MockURLSession(
        data: Data("forbidden".utf8),
        statusCode: HTTPStatus.forbidden.rawValue
    )
    let client = AdminAPIClient(
        baseURL: URL(string: "https://api.example.com/prod")!,
        idToken: "id-token",
        urlSession: http
    )

    do {
        _ = try await client.listTenants()
        throw CheckFailure("Expected APIError")
    } catch let error as APIError {
        try expectEqual(error, APIError(statusCode: HTTPStatus.forbidden.rawValue, detail: "forbidden"))
    }
}

private func fixtureConfiguration() throws -> AdminConfiguration {
    try AdminConfiguration(
        cognitoDomain: "https://tenkacloud.auth.ap-northeast-1.amazoncognito.com",
        clientID: "client",
        apiBaseURL: "https://api.example.com/prod"
    )
}

private enum HTTPStatus: Int {
    case ok = 200
    case noContent = 204
    case forbidden = 403
}

private final class MockURLSession: URLSessionProtocol, @unchecked Sendable {
    private let data: Data
    private let statusCode: Int
    private(set) var requests: [URLRequest] = []

    init(data: Data, statusCode: Int) {
        self.data = data
        self.statusCode = statusCode
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
        return (data, response)
    }
}

private func tenantsEnvelopeData() -> Data {
    """
    {
      "data": [
        {
          "tenantId": "t1",
          "tenantName": "ACME",
          "email": "admin@example.com",
          "tier": "basic",
          "tenantStatus": "Complete"
        }
      ]
    }
    """.data(using: .utf8)!
}

private func tenantEnvelopeData() -> Data {
    """
    {
      "data": {
        "tenantId": "t1",
        "tenantName": "ACME",
        "email": "admin@example.com",
        "tier": "advanced",
        "tenantStatus": "In progress"
      }
    }
    """.data(using: .utf8)!
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw CheckFailure(message)
    }
}

private func expectEqual<T: Equatable>(_ actual: T, _ expected: T) throws {
    if actual != expected {
        throw CheckFailure("Expected \(expected), got \(actual)")
    }
}

private func expectThrows<E: Error & Equatable>(_ expected: E, _ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch let error as E {
        try expectEqual(error, expected)
        return
    }
    throw CheckFailure("Expected \(expected) to be thrown")
}

private func unwrap<T>(_ value: T?, _ message: String) throws -> T {
    guard let value else {
        throw CheckFailure(message)
    }
    return value
}

private struct CheckFailure: Error, CustomStringConvertible {
    var description: String

    init(_ description: String) {
        self.description = description
    }
}
