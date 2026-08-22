import SwiftUI

struct MobileAccountSheet: View {
    @ObservedObject var account: AccountStore
    let categories: [NicheCategory]
    @Environment(\.dismiss) private var dismiss
    private let supportURL = URL(string: "https://buymeacoffee.com/0wtynrfutb")!
    @State private var selectedTags: [String] = []
    @State private var authMode: AuthMode = .signIn
    @State private var identifier = ""
    @State private var username = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var verificationCode = ""
    @State private var newUsername = ""
    @State private var newEmail = ""
    @State private var emailChangeCode = ""

    private enum AuthMode: String, CaseIterable, Identifiable {
        case signIn
        case create

        var id: String { rawValue }
        var label: String { self == .signIn ? "Sign in" : "Create account" }
    }

    private var adminPreviewStateLabel: String {
        switch account.adminPreviewMode {
        case .real: "real account"
        case .signedIn: "preview signed in"
        case .signedOut: "preview signed out"
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Admin preview") {
                    Label("Temporary local testing", systemImage: "wrench.and.screwdriver.fill")
                        .font(.subheadline.weight(.bold))
                    Text("Preview the signed-in or signed-out interface while the real providers are being set up. This never creates, signs in, or signs out a real account.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    HStack(spacing: 8) {
                        Button("Signed in") {
                            account.setAdminPreviewMode(.signedIn)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(account.adminPreviewMode == .signedIn ? Color(hex: "#6F48E5") : .gray)

                        Button("Signed out") {
                            account.setAdminPreviewMode(.signedOut)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(account.adminPreviewMode == .signedOut ? Color(hex: "#6F48E5") : .gray)
                    }

                    if account.isAdminPreviewActive {
                        Button("Use real account session") {
                            account.setAdminPreviewMode(.real)
                        }
                        .foregroundStyle(Color(hex: "#4F2EB8"))
                    }

                    Text("Current state: \(adminPreviewStateLabel)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                Section("Shared account") {
                    if let profile = account.presentedProfile {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(profile.displayName).font(.subheadline.weight(.bold))
                                if !profile.email.isEmpty { Text(profile.email).font(.caption).foregroundStyle(.secondary) }
                            }
                        } icon: {
                            Image(systemName: "checkmark.shield.fill").foregroundStyle(.green)
                        }
                        Text("Your interest tags sync with the website account. Appearance, alerts, and board layout stay device-specific.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Use Google or sign in with the email and password you created for what’s popular?. Email accounts are verified with a one-time code.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Picker("Account access", selection: $authMode) {
                            ForEach(AuthMode.allCases) { mode in
                                Text(mode.label).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)

                        Button {
                            Task { await account.signInWithGoogle() }
                        } label: {
                            Label(account.isLoading ? "Opening Google…" : account.providerStatus?.googleConfigured == false ? "Google sign-in unavailable" : "Continue with Google", systemImage: "g.circle.fill")
                        }
                        .disabled(account.isLoading || account.providerStatus?.googleConfigured == false)

                        if account.providerStatus?.googleConfigured == false {
                            Text("Google sign-in is not enabled on this deployment yet.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        if account.verificationEmail == nil {
                            if authMode == .signIn {
                                TextField("Username or email", text: $identifier)
                                    .textContentType(.username)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                SecureField("Password", text: $password)
                                    .textContentType(.password)
                                Button {
                                    Task { await account.signIn(identifier: identifier, password: password) }
                                } label: {
                                    Label(account.isLoading ? "Signing in…" : "Sign in", systemImage: "arrow.right.circle.fill")
                                }
                                .disabled(account.isLoading || identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                            } else {
                                TextField("Username", text: $username)
                                    .textContentType(.username)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                TextField("Email", text: $email)
                                    .textContentType(.emailAddress)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                SecureField("Password (12+ characters)", text: $password)
                                    .textContentType(.newPassword)
                                SecureField("Confirm password", text: $confirmPassword)
                                    .textContentType(.newPassword)
                                Button {
                                    Task { _ = await account.beginEmailSignup(username: username, email: email, password: password) }
                                } label: {
                                    Label(account.isLoading ? "Sending code…" : account.providerStatus?.emailVerificationConfigured == false ? "Email verification unavailable" : "Email me a verification code", systemImage: "envelope.badge.fill")
                                }
                                .disabled(account.isLoading || account.providerStatus?.emailVerificationConfigured == false || username.isEmpty || email.isEmpty || password.count < 12 || password != confirmPassword)
                            }
                            if account.providerStatus?.emailVerificationConfigured == false {
                                Text("Email verification is not enabled on this deployment yet, so no code can be sent.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Enter the six-digit code sent to \(account.verificationEmail ?? "your email")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextField("Verification code", text: $verificationCode)
                                .keyboardType(.numberPad)
                                .textContentType(.oneTimeCode)
                                .onChange(of: verificationCode) { _, value in
                                    verificationCode = String(value.filter(\.isNumber).prefix(6))
                                }
                            Button {
                                Task { await account.verifyEmailSignup(code: verificationCode) }
                            } label: {
                                Label(account.isLoading ? "Checking code…" : "Verify and create account", systemImage: "checkmark.shield.fill")
                            }
                            .disabled(account.isLoading || verificationCode.count != 6)
                        }

                        Text("Your password is sent only over HTTPS and the app keeps the resulting session in the iPhone Keychain.")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                    }

                    if account.isLinked {
                        Button("Sign out on this phone", role: .destructive) {
                            Task { await account.signOut() }
                        }
                    }
                }

                if let profile = account.presentedProfile, account.isLinked {
                    Section("Profile details") {
                        if profile.canEditIdentity {
                            TextField("Username", text: $newUsername)
                                .textContentType(.username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            Button {
                                Task { await account.updateUsername(newUsername) }
                            } label: {
                                HStack {
                                    Text("Save username")
                                    Spacer()
                                    if account.isLoading { ProgressView() }
                                }
                            }
                            .disabled(account.isLoading || newUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || newUsername == profile.username)

                            LabeledContent("Verified email", value: profile.email)
                            TextField("New email", text: $newEmail)
                                .textContentType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            Button {
                                Task { _ = await account.beginEmailChange(newEmail) }
                            } label: {
                                HStack {
                                    Text("Email me a verification code")
                                    Spacer()
                                    if account.isLoading { ProgressView() }
                                }
                            }
                            .disabled(account.isLoading || newEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            if account.emailChangeTarget != nil {
                                Text("Enter the six-digit code sent to \(account.emailChangeTarget ?? newEmail).")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                TextField("Email verification code", text: $emailChangeCode)
                                    .keyboardType(.numberPad)
                                    .textContentType(.oneTimeCode)
                                    .onChange(of: emailChangeCode) { _, value in
                                        emailChangeCode = String(value.filter(\.isNumber).prefix(6))
                                    }
                                Button {
                                    Task { await account.verifyEmailChange(code: emailChangeCode) }
                                } label: {
                                    HStack {
                                        Text("Verify new email")
                                        Spacer()
                                        if account.isLoading { ProgressView() }
                                    }
                                }
                                .disabled(account.isLoading || emailChangeCode.count != 6)
                            }
                        } else {
                            Text("Your sign-in provider manages this identity. You can still change your shared interests below.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if !categories.isEmpty {
                    Section("Shared For You interests") {
                        Text("These choices are stored on your account and appear on the website too.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 125), spacing: 8)], spacing: 8) {
                            ForEach(categories) { category in
                                let selected = selectedTags.contains(category.id)
                                Button {
                                    if selected { selectedTags.removeAll { $0 == category.id } }
                                    else { selectedTags.append(category.id) }
                                } label: {
                                    HStack(spacing: 6) {
                                        Circle().fill(Color(hex: category.accent)).frame(width: 7, height: 7)
                                        Text(category.label).lineLimit(1)
                                        Spacer(minLength: 0)
                                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                            .font(.caption)
                                    }
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 9)
                                    .foregroundStyle(selected ? Color(hex: "#4F2EB8") : .primary)
                                    .background(selected ? Color(hex: category.accent).opacity(0.18) : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        Button {
                            Task { await account.saveTags(selectedTags) }
                        } label: {
                            HStack {
                                Text("Save shared interests")
                                Spacer()
                                if account.isLoading { ProgressView() }
                            }
                        }
                        .disabled(!account.isLinked || account.isLoading)
                    }
                }

                Section("Support the project") {
                    Text("If this digest is useful, you can support its next snapshot.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Link(destination: supportURL) {
                        HStack(spacing: 10) {
                            Image(systemName: "cup.and.saucer.fill")
                                .foregroundStyle(Color(hex: "#BD5FFF"))
                            Text("Buy me a coffee")
                                .font(.subheadline.weight(.bold))
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityHint("Opens the Buy Me a Coffee supporter page")
                }

                if let message = account.message {
                    Section {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Profile")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                selectedTags = account.presentedProfile?.tags ?? []
                newUsername = account.presentedProfile?.username ?? ""
                Task { await account.loadProviderStatus() }
            }
            .onChange(of: account.presentedProfile?.tags ?? []) { _, tags in
                selectedTags = tags
            }
            .onChange(of: account.presentedProfile?.username ?? "") { _, username in
                newUsername = username
            }
        }
    }
}
