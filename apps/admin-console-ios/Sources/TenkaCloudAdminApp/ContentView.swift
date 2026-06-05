import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AdminAppModel
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if model.settings.configuration == nil {
                    SettingsView(settings: model.settings, isRequired: true)
                } else if model.isSignedIn {
                    TenantListView(model: model)
                } else {
                    SignInView(model: model)
                }
            }
            .navigationTitle("TenkaCloud")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showingSettings) {
                NavigationStack {
                    SettingsView(settings: model.settings, isRequired: false)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }
}

private struct SignInView: View {
    @ObservedObject var model: AdminAppModel

    var body: some View {
        ContentUnavailableView {
            Label("Admin Console", systemImage: "person.badge.key")
        } description: {
            Text("Sign in with the Control Plane Cognito Hosted UI.")
        } actions: {
            Button {
                Task { await model.signIn() }
            } label: {
                if model.isLoading {
                    ProgressView()
                } else {
                    Text("Sign In")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isLoading)
        }
        .errorAlert(message: $model.errorMessage)
    }
}
