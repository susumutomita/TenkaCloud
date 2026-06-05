import Foundation
import SwiftUI
import TenkaCloudAdminCore

@MainActor
final class AdminAppModel: ObservableObject {
    @Published var settings = AdminSettings()
    @Published private(set) var tokens: TokenSet?
    @Published private(set) var tenants: [Tenant] = []
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var showDeprovisioned = false

    private let authenticator = WebAuthenticator()

    var isSignedIn: Bool {
        tokens?.isExpired == false
    }

    var visibleTenants: [Tenant] {
        showDeprovisioned ? tenants : tenants.filter { !$0.isDeprovisioned }
    }

    func signIn() async {
        guard let configuration = settings.configuration else {
            errorMessage = settings.validationMessage ?? "Admin configuration is incomplete."
            return
        }

        settings.save()
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let oauth = CognitoOAuthClient(configuration: configuration)
            let session = try oauth.makeAuthorizationSession()
            let callbackURL = try await authenticator.authenticate(
                url: session.authorizationURL,
                callbackURLScheme: "tenkacloud-admin"
            )
            tokens = try await oauth.exchangeCode(callbackURL: callbackURL, session: session)
            await refreshTenants()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        if let configuration = settings.configuration, let refreshToken = tokens?.refreshToken {
            do {
                try await CognitoOAuthClient(configuration: configuration).revoke(refreshToken: refreshToken)
            } catch {
                errorMessage = "Signed out locally. Cognito revoke failed: \(error.localizedDescription)"
            }
        }
        tokens = nil
        tenants = []
    }

    func refreshTenants() async {
        guard let client = apiClient else {
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            tenants = try await client.listTenants()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createTenant(name: String, email: String, tier: TenantTier) async -> Bool {
        guard let client = apiClient else {
            return false
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            _ = try await client.createTenant(
                CreateTenantRequest(tenantName: name, email: email, tier: tier)
            )
            await refreshTenants()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteTenant(_ tenant: Tenant) async {
        guard let client = apiClient else {
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            try await client.deleteTenant(tenantId: tenant.tenantId)
            await refreshTenants()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var apiClient: AdminAPIClient? {
        guard let configuration = settings.configuration, let tokens else {
            return nil
        }
        return AdminAPIClient(baseURL: configuration.apiBaseURL, idToken: tokens.idToken)
    }
}
