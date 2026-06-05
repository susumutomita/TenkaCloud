import AuthenticationServices
import Foundation

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
final class WebAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, callbackURLScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackURLScheme
            ) { callbackURL, error in
                self.session = nil
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: error ?? WebAuthenticatorError.missingCallbackURL)
                }
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session

            if !session.start() {
                self.session = nil
                continuation.resume(throwing: WebAuthenticatorError.failedToStart)
            }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first { $0.isKeyWindow } ?? UIWindow()
        }
        #elseif os(macOS)
        MainActor.assumeIsolated {
            NSApplication.shared.windows.first ?? NSWindow()
        }
        #else
        ASPresentationAnchor()
        #endif
    }
}

enum WebAuthenticatorError: Error, LocalizedError {
    case failedToStart
    case missingCallbackURL

    var errorDescription: String? {
        switch self {
        case .failedToStart:
            "Could not start the Cognito sign-in session."
        case .missingCallbackURL:
            "Cognito sign-in finished without a callback URL."
        }
    }
}
