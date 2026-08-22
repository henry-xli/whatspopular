import SwiftUI

struct MobileAccountSheet: View {
    @ObservedObject var account: AccountStore
    let categories: [NicheCategory]
    @Environment(\.dismiss) private var dismiss
    @State private var selectedTags: [String] = []
    @State private var authMode: AuthMode = .signIn
    @State private var identifier = ""
    @State private var username = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var verificationCode = ""

    private enum AuthMode: String, CaseIterable, Identifiable {
        case signIn
        case create

        var id: String { rawValue }
        var label: String { self == .signIn ? "Sign in" : "Create account" }
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Shared account") {
                    if let profile = account.profile {
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
                            Label(account.isLoading ? "Opening Google…" : "Continue with Google", systemImage: "g.circle.fill")
                        }
                        .disabled(account.isLoading)

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
                                    Label(account.isLoading ? "Sending code…" : "Email me a verification code", systemImage: "envelope.badge.fill")
                                }
                                .disabled(account.isLoading || username.isEmpty || email.isEmpty || password.count < 12 || password != confirmPassword)
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

                        Divider()
                        Button {
                            Task { await account.startLinking() }
                        } label: {
                            Label(account.isLinking ? "Waiting for website approval…" : "Use an existing website account", systemImage: "link")
                        }
                        .disabled(account.isLoading || account.isLinking)
                    }

                    if let pendingLink = account.pendingLink {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Approve the code on the website")
                                .font(.caption.weight(.bold))
                            Text(pendingLink.code)
                                .font(.system(.title2, design: .monospaced).weight(.black))
                                .foregroundStyle(Color(hex: "#6F48E5"))
                            Text("This code expires soon and can be used only once.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if account.isLinked {
                        Button("Link again on another device") {
                            Task { await account.startLinking() }
                        }
                        .disabled(account.isLinking)
                        Button("Sign out on this phone", role: .destructive) {
                            Task { await account.signOut() }
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
                selectedTags = account.profile?.tags ?? []
            }
            .onChange(of: account.profile?.tags ?? []) { _, tags in
                selectedTags = tags
            }
        }
    }
}
