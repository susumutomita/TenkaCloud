import Foundation

public struct AdminAPIClient: Sendable {
    public var baseURL: URL
    public var idToken: String
    public var urlSession: URLSessionProtocol

    public init(baseURL: URL, idToken: String, urlSession: URLSessionProtocol = URLSession.shared) {
        self.baseURL = baseURL
        self.idToken = idToken
        self.urlSession = urlSession
    }

    public func listTenants() async throws -> [Tenant] {
        let request = try makeRequest(path: "tenants")
        let (data, response) = try await urlSession.data(for: request)
        try HTTPResponseValidator.validate(response: response, data: data)

        if let direct = try? JSONDecoder().decode([Tenant].self, from: data) {
            return direct
        }
        return try JSONDecoder().decode(TenantListEnvelope.self, from: data).data ?? []
    }

    @discardableResult
    public func createTenant(_ requestBody: CreateTenantRequest) async throws -> Tenant {
        var request = try makeRequest(path: "tenants")
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(requestBody)

        let (data, response) = try await urlSession.data(for: request)
        try HTTPResponseValidator.validate(response: response, data: data)
        return try JSONDecoder().decode(TenantEnvelope.self, from: data).data
    }

    public func deleteTenant(tenantId: String) async throws {
        var request = try makeRequest(path: "tenants/\(Self.urlPathComponent(tenantId))")
        request.httpMethod = "DELETE"
        let (data, response) = try await urlSession.data(for: request)
        try HTTPResponseValidator.validate(response: response, data: data)
    }

    public func makeRequest(path: String) throws -> URLRequest {
        guard let url = URL(string: path.trimmingCharacters(in: CharacterSet(charactersIn: "/")), relativeTo: baseURL.appendingPathComponent("")) else {
            throw URLValidationError.invalidURL(path)
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        return request
    }

    static func urlPathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#[]@!$&'()*+,;=")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

private struct TenantEnvelope: Decodable {
    var data: Tenant
}

private struct TenantListEnvelope: Decodable {
    var data: [Tenant]?
}
