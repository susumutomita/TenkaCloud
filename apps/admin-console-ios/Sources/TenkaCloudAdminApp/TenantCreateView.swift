import SwiftUI
import TenkaCloudAdminCore

struct TenantCreateView: View {
    @ObservedObject var model: AdminAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var tenantName = ""
    @State private var email = ""
    @State private var tier = TenantTier.basic

    var body: some View {
        Form {
            Section("Tenant") {
                TextField("Name", text: $tenantName)
                TextField("Admin email", text: $email)
                    .adminTextInputAutocapitalizationNever()
                    .adminEmailKeyboard()
            }

            Section("Tier") {
                Picker("Tier", selection: $tier) {
                    ForEach(TenantTier.allCases) { tier in
                        Text(tier.rawValue.capitalized).tag(tier)
                    }
                }
            }
        }
        .navigationTitle("Create Tenant")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") {
                    Task {
                        let created = await model.createTenant(
                            name: tenantName.trimmingCharacters(in: .whitespacesAndNewlines),
                            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                            tier: tier
                        )
                        if created {
                            dismiss()
                        }
                    }
                }
                .disabled(isSubmitDisabled || model.isLoading)
            }
        }
    }

    private var isSubmitDisabled: Bool {
        tenantName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
