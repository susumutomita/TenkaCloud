import Foundation

public enum URLValidationError: Error, Equatable, LocalizedError {
    case invalidURL(String)
    case nonHTTPSURL(String)
    case nonCognitoDomain(String)

    public var errorDescription: String? {
        switch self {
        case let .invalidURL(value):
            "Invalid URL: \(value)"
        case let .nonHTTPSURL(value):
            "URL must use HTTPS: \(value)"
        case let .nonCognitoDomain(value):
            "Cognito domain must end with .amazoncognito.com: \(value)"
        }
    }
}

public enum URLValidation {
    public static func normalizedCognitoDomain(_ value: String) throws -> URL {
        let url = try normalizedHTTPSURL(value)
        guard url.host?.hasSuffix(".amazoncognito.com") == true else {
            throw URLValidationError.nonCognitoDomain(value)
        }
        return url
    }

    public static func normalizedAPIBaseURL(_ value: String) throws -> URL {
        try normalizedHTTPSURL(value)
    }

    public static func normalizedHTTPSURL(_ value: String) throws -> URL {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: candidate), components.host?.isEmpty == false else {
            throw URLValidationError.invalidURL(value)
        }
        guard components.scheme == "https" else {
            throw URLValidationError.nonHTTPSURL(value)
        }
        components.path = components.path.trimmingTrailingSlashes()
        guard let url = components.url else {
            throw URLValidationError.invalidURL(value)
        }
        return url
    }
}

private extension String {
    func trimmingTrailingSlashes() -> String {
        var copy = self
        while copy.count > 1 && copy.last == "/" {
            copy.removeLast()
        }
        return copy
    }
}
