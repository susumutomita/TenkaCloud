import SwiftUI

struct SettingsView: View {
    @ObservedObject var settings: AdminSettings
    var isRequired: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Cognito") {
                TextField("Domain", text: $settings.cognitoDomain)
                    .adminTextInputAutocapitalizationNever()
                    .adminURLKeyboard()
                TextField("Client ID", text: $settings.clientID)
                    .adminTextInputAutocapitalizationNever()
            }

            Section("Control Plane API") {
                TextField("Base URL", text: $settings.apiBaseURL)
                    .adminTextInputAutocapitalizationNever()
                    .adminURLKeyboard()
                TextField("Scope", text: $settings.scope)
                    .adminTextInputAutocapitalizationNever()
            }

            if let validationMessage = settings.validationMessage {
                Section {
                    Label(validationMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(isRequired ? "Setup" : "Settings")
        .toolbar {
            if !isRequired {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    settings.save()
                    if !isRequired {
                        dismiss()
                    }
                }
                .disabled(settings.validationMessage != nil)
            }
        }
    }
}
