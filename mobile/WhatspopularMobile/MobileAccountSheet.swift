import SwiftUI

struct MobileAccountSheet: View {
    @ObservedObject var account: AccountStore
    let categories: [NicheCategory]
    @Environment(\.dismiss) private var dismiss
    @State private var selectedTags: [String] = []

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
                        Text("Link with ChatGPT on the website to save your digest across devices.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button {
                            Task { await account.startLinking() }
                        } label: {
                            Label(account.isLinking ? "Waiting for approval…" : "Link this phone", systemImage: "link")
                        }
                        .disabled(account.isLinking)
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
                                    guard account.isLinked else { return }
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
                                }
                                .buttonStyle(.plain)
                                .disabled(!account.isLinked)
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
            .navigationTitle("Account")
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
