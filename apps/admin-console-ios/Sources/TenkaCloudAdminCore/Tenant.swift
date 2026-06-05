import Foundation

public enum TenantTier: String, CaseIterable, Codable, Identifiable, Sendable {
    case basic
    case advanced
    case platinum

    public var id: String { rawValue }
}

public enum StatusTone: String, Equatable, Sendable {
    case success
    case inProgress
    case failed
    case inactive
    case unknown
}

public struct Tenant: Codable, Equatable, Identifiable, Sendable {
    public var tenantId: String
    public var tenantName: String
    public var email: String
    public var tier: String
    public var tenantStatus: String
    public var isActive: Bool?
    public var tenantConfig: String?
    public var tenantPhone: String?
    public var tenantAddress: String?
    public var createdAt: String?

    public init(
        tenantId: String,
        tenantName: String,
        email: String,
        tier: String,
        tenantStatus: String,
        isActive: Bool? = nil,
        tenantConfig: String? = nil,
        tenantPhone: String? = nil,
        tenantAddress: String? = nil,
        createdAt: String? = nil
    ) {
        self.tenantId = tenantId
        self.tenantName = tenantName
        self.email = email
        self.tier = tier
        self.tenantStatus = tenantStatus
        self.isActive = isActive
        self.tenantConfig = tenantConfig
        self.tenantPhone = tenantPhone
        self.tenantAddress = tenantAddress
        self.createdAt = createdAt
    }

    public var id: String { tenantId }

    public var isDeprovisioned: Bool {
        let normalized = tenantStatus.lowercased()
        return normalized == "deleted" || normalized == "deprovisioned" || isActive == false
    }

    public var statusTone: StatusTone {
        if isDeprovisioned {
            return .inactive
        }
        switch tenantStatus.lowercased() {
        case "complete":
            return .success
        case "in progress":
            return .inProgress
        case "failed":
            return .failed
        default:
            return .unknown
        }
    }

    public var tierTone: StatusTone {
        switch tier.lowercased() {
        case TenantTier.platinum.rawValue:
            return .success
        case TenantTier.advanced.rawValue:
            return .inProgress
        case TenantTier.basic.rawValue:
            return .inactive
        default:
            return .unknown
        }
    }
}

public struct ParsedTenantConfig: Codable, Equatable, Sendable {
    public var userPoolId: String?
    public var appClientId: String?
    public var apiGatewayUrl: String?
    public var applicationAdminConsoleUrl: String?
    public var provisioningBuildId: String?
    public var provisioningProjectName: String?
    public var provisioningRegion: String?
    public var provisioningAccountId: String?

    public init(
        userPoolId: String? = nil,
        appClientId: String? = nil,
        apiGatewayUrl: String? = nil,
        applicationAdminConsoleUrl: String? = nil,
        provisioningBuildId: String? = nil,
        provisioningProjectName: String? = nil,
        provisioningRegion: String? = nil,
        provisioningAccountId: String? = nil
    ) {
        self.userPoolId = userPoolId
        self.appClientId = appClientId
        self.apiGatewayUrl = apiGatewayUrl
        self.applicationAdminConsoleUrl = applicationAdminConsoleUrl
        self.provisioningBuildId = provisioningBuildId
        self.provisioningProjectName = provisioningProjectName
        self.provisioningRegion = provisioningRegion
        self.provisioningAccountId = provisioningAccountId
    }
}

public func parseTenantConfig(_ raw: String?) -> ParsedTenantConfig {
    guard let raw, let data = raw.data(using: .utf8) else {
        return ParsedTenantConfig()
    }
    return (try? JSONDecoder().decode(ParsedTenantConfig.self, from: data)) ?? ParsedTenantConfig()
}

public struct CreateTenantRequest: Codable, Equatable, Sendable {
    public var tenantName: String
    public var email: String
    public var tier: TenantTier
    public var tenantStatus: String

    public init(tenantName: String, email: String, tier: TenantTier) {
        self.tenantName = tenantName
        self.email = email
        self.tier = tier
        self.tenantStatus = "In progress"
    }
}
