import SwiftUI
import TenkaCloudAdminCore

struct TenantListView: View {
    @ObservedObject var model: AdminAppModel
    @State private var showingCreateTenant = false
    @State private var tenantPendingDelete: Tenant?

    var body: some View {
        List {
            if model.tenants.contains(where: \.isDeprovisioned) {
                Toggle("Show deprovisioned tenants", isOn: $model.showDeprovisioned)
            }

            ForEach(model.visibleTenants) { tenant in
                NavigationLink {
                    TenantDetailView(tenant: tenant)
                } label: {
                    TenantRowView(tenant: tenant)
                }
                .swipeActions {
                    Button(role: .destructive) {
                        tenantPendingDelete = tenant
                    } label: {
                        Label("Deprovision", systemImage: "archivebox")
                    }
                    .disabled(tenant.isDeprovisioned)
                }
            }
        }
        .overlay {
            if model.isLoading && model.tenants.isEmpty {
                ProgressView()
            }
        }
        .refreshable {
            await model.refreshTenants()
        }
        .navigationTitle("Tenants")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    Task { await model.signOut() }
                } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await model.refreshTenants() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoading)

                Button {
                    showingCreateTenant = true
                } label: {
                    Label("Create Tenant", systemImage: "plus")
                }
            }
        }
        .task {
            if model.tenants.isEmpty {
                await model.refreshTenants()
            }
        }
        .sheet(isPresented: $showingCreateTenant) {
            NavigationStack {
                TenantCreateView(model: model)
            }
        }
        .alert("Deprovision tenant?", isPresented: deleteAlertPresented) {
            Button("Cancel", role: .cancel) {
                tenantPendingDelete = nil
            }
            Button("Deprovision", role: .destructive) {
                guard let tenant = tenantPendingDelete else {
                    return
                }
                Task {
                    await model.deleteTenant(tenant)
                    tenantPendingDelete = nil
                }
            }
        } message: {
            Text(tenantPendingDelete?.tenantName ?? "")
        }
        .errorAlert(message: $model.errorMessage)
    }

    private var deleteAlertPresented: Binding<Bool> {
        Binding(
            get: { tenantPendingDelete != nil },
            set: { isPresented in
                if !isPresented {
                    tenantPendingDelete = nil
                }
            }
        )
    }
}

private struct TenantRowView: View {
    var tenant: Tenant

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(tenant.tenantName)
                    .font(.headline)
                Spacer()
                StatusPill(text: tenant.tenantStatus, tone: tenant.statusTone)
            }

            Text(tenant.email)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            HStack {
                StatusPill(text: tenant.tier, tone: tenant.tierTone)
                Text(tenant.tenantId)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct TenantDetailView: View {
    var tenant: Tenant
    private var tenantConfig: ParsedTenantConfig {
        parseTenantConfig(tenant.tenantConfig)
    }

    var body: some View {
        List {
            Section("Tenant") {
                LabeledContent("ID", value: tenant.tenantId)
                LabeledContent("Name", value: tenant.tenantName)
                LabeledContent("Email", value: tenant.email)
                LabeledContent("Tier", value: tenant.tier)
                LabeledContent("Status", value: tenant.tenantStatus)
            }

            if tenantConfig.applicationAdminConsoleUrl != nil || tenantConfig.apiGatewayUrl != nil {
                Section("Application Plane") {
                    if let url = tenantConfig.applicationAdminConsoleUrl {
                        Link(url, destination: URL(string: url)!)
                    }
                    if let url = tenantConfig.apiGatewayUrl {
                        LabeledContent("API", value: url)
                    }
                }
            }
        }
        .navigationTitle(tenant.tenantName)
    }
}

private struct StatusPill: View {
    var text: String
    var tone: StatusTone

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch tone {
        case .success:
            .green
        case .inProgress:
            .blue
        case .failed:
            .red
        case .inactive:
            .secondary
        case .unknown:
            .orange
        }
    }

    private var background: Color {
        foreground.opacity(0.12)
    }
}
