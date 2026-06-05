import SwiftUI

extension View {
    @ViewBuilder
    func adminTextInputAutocapitalizationNever() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func adminURLKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func adminEmailKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.emailAddress)
        #else
        self
        #endif
    }
}
