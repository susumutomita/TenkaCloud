import Foundation

public protocol URLSessionProtocol: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessionProtocol {}

public struct APIError: Error, Equatable, LocalizedError {
    public var statusCode: Int
    public var detail: String

    public init(statusCode: Int, detail: String) {
        self.statusCode = statusCode
        self.detail = detail
    }

    public var errorDescription: String? {
        detail.isEmpty ? "API request failed with status \(statusCode)." : detail
    }
}

enum HTTPResponseValidator {
    static func validate(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError(statusCode: 0, detail: "Response was not HTTP.")
        }
        guard HTTPStatusClass.isSuccess(httpResponse.statusCode) else {
            let detail = String(data: data, encoding: .utf8) ?? httpResponse.description
            throw APIError(statusCode: httpResponse.statusCode, detail: detail)
        }
    }
}

enum HTTPStatusClass {
    static func isSuccess(_ statusCode: Int) -> Bool {
        statusCode / 100 == 2
    }
}
