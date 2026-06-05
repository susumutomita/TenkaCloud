import CryptoKit
import Foundation
import Security

public enum PKCEError: Error, Equatable {
    case randomGenerationFailed
}

public enum PKCE {
    public static func generateVerifier(length: Int = 64) throws -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw PKCEError.randomGenerationFailed
        }
        return base64URLEncoded(Data(bytes)).prefix(length).description
    }

    public static func deriveChallenge(verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncoded(Data(digest))
    }

    static func base64URLEncoded(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
