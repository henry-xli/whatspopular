import Foundation
import Security
import UIKit
import AuthenticationServices

struct SharedAccountProfile: Codable, Equatable {
    var hasProfile: Bool
    var tags: [String]
    var email: String
    var displayName: String
    var updatedAt: String?
    var username: String
    var emailVerified: Bool
    var canEditIdentity: Bool
}

private struct MobileSession: Codable {
    let accessToken: String
    let refreshToken: String
    let accessExpiresAt: String
    let refreshExpiresAt: String
}

private struct ProfileResponse: Codable {
    let hasProfile: Bool?
    let tags: [String]?
    let email: String?
    let displayName: String?
    let updatedAt: String?
    let username: String?
    let emailVerified: Bool?
    let canEditIdentity: Bool?
}

private struct LinkStartResponse: Codable {
    let requestId: String
    let pairingCode: String
    let pairingSecret: String
    let approvalURL: URL
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case requestId
        case pairingCode
        case pairingSecret
        case approvalURL = "approvalUrl"
        case expiresAt
    }
}

private struct LinkExchangeResponse: Codable {
    let accessToken: String
    let refreshToken: String
    let accessExpiresAt: String
    let refreshExpiresAt: String
    let profile: ProfileResponse
}

private struct SignupStartResponse: Codable {
    let pending: Bool
    let email: String
    let expiresAt: String
}

private struct EmailChangeStartResponse: Codable {
    let pending: Bool
    let email: String
    let expiresAt: String
}

struct ProviderStatus: Codable {
    let emailVerificationConfigured: Bool
    let googleConfigured: Bool
}

private struct APIErrorPayload: Codable {
    let error: String?
    let conflict: Bool?
    let tags: [String]?
    let updatedAt: String?
}

struct PendingMobileLink: Equatable {
    let code: String
    let expiresAt: String
}

enum AccountStoreError: LocalizedError {
    case notLinked
    case invalidResponse
    case server(String)
    case conflict

    var errorDescription: String? {
        switch self {
        case .notLinked: "Link this app to your website account first."
        case .invalidResponse: "The account service returned an invalid response."
        case .server(let message): message
        case .conflict: "Your interests changed on another device. They were reloaded; review and save again."
        }
    }
}

@MainActor
final class AccountStore: ObservableObject {
    @Published private(set) var profile: SharedAccountProfile?
    @Published private(set) var pendingLink: PendingMobileLink?
    @Published private(set) var isLinking = false
    @Published private(set) var isLoading = false
    @Published private(set) var message: String?
    @Published private(set) var verificationEmail: String?
    @Published private(set) var emailChangeTarget: String?
    @Published private(set) var providerStatus: ProviderStatus?

    private var session: MobileSession?
    private var refreshTask: Task<MobileSession, Error>?
    private var googleAuth: GoogleAuthCoordinator?

    init() {
        session = SecureMobileSessionStore.load()
    }

    var isLinked: Bool { session != nil }

    func bootstrap() async {
        guard session != nil else { return }
        await refreshProfile()
    }

    func loadProviderStatus() async {
        do {
            providerStatus = try await decodeJSON(path: "/api/auth/providers", method: "GET")
        } catch {
            providerStatus = nil
        }
    }

    func refreshProfile() async {
        guard session != nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response: ProfileResponse = try await authorizedJSON(
                path: "/api/account/profile",
                method: "GET"
            )
            profile = makeProfile(response)
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    func saveTags(_ tags: [String]) async {
        guard session != nil else {
            message = AccountStoreError.notLinked.localizedDescription
            return
        }
        do {
            var uniqueTags: [String] = []
            for tag in tags where !uniqueTags.contains(tag) { uniqueTags.append(tag) }
            let body: [String: Any] = [
                "tags": uniqueTags,
                "expectedUpdatedAt": profile?.updatedAt ?? NSNull(),
            ]
            let response: ProfileResponse = try await authorizedJSON(
                path: "/api/account/profile",
                method: "PUT",
                body: body
            )
            profile = makeProfile(response)
            message = "Saved to your account."
        } catch AccountStoreError.conflict {
            await refreshProfile()
            message = AccountStoreError.conflict.localizedDescription
        } catch {
            message = error.localizedDescription
        }
    }

    func updateUsername(_ username: String) async {
        guard session != nil, !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isLoading else { return }
        isLoading = true
        message = nil
        defer { isLoading = false }
        do {
            let response: ProfileResponse = try await authorizedJSON(
                path: "/api/account/identity",
                method: "PATCH",
                body: ["username": username]
            )
            profile = makeProfile(response)
            message = "Username saved."
        } catch {
            message = error.localizedDescription
        }
    }

    func beginEmailChange(_ email: String) async -> Bool {
        guard session != nil, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isLoading else { return false }
        isLoading = true
        message = nil
        defer { isLoading = false }
        do {
            let response: EmailChangeStartResponse = try await authorizedJSON(
                path: "/api/account/email/start",
                method: "POST",
                body: ["email": email]
            )
            emailChangeTarget = response.email
            message = "Enter the six-digit code sent to \(response.email)."
            return response.pending
        } catch {
            message = error.localizedDescription
            return false
        }
    }

    func verifyEmailChange(code: String) async {
        guard emailChangeTarget != nil, !isLoading else { return }
        isLoading = true
        message = nil
        defer { isLoading = false }
        do {
            let response: ProfileResponse = try await authorizedJSON(
                path: "/api/account/email/verify",
                method: "POST",
                body: ["code": code]
            )
            profile = makeProfile(response)
            emailChangeTarget = nil
            message = "Email updated and verified."
        } catch {
            message = error.localizedDescription
        }
    }

    func signIn(identifier: String, password: String) async {
        guard !isLoading else { return }
        isLoading = true
        message = nil
        defer { isLoading = false }
        do {
            let response: LinkExchangeResponse = try await publicJSON(
                path: "/api/auth/login",
                method: "POST",
                body: ["identifier": identifier, "password": password, "client": "mobile"]
            )
            install(response)
            message = "Signed in."
        } catch {
            message = error.localizedDescription
        }
    }

    func beginEmailSignup(username: String, email: String, password: String) async -> Bool {
        if providerStatus?.emailVerificationConfigured != true { await loadProviderStatus() }
        guard providerStatus?.emailVerificationConfigured == true else {
            message = "Email sign-up is unavailable until email delivery is configured. Try Google sign-in or contact the site owner."
            return false
        }
        guard !isLoading else { return false }
        isLoading = true
        message = nil
        defer { isLoading = false }
        do {
            let response: SignupStartResponse = try await publicJSON(
                path: "/api/auth/signup/start",
                method: "POST",
                body: ["username": username, "email": email, "password": password, "client": "mobile"]
            )
            verificationEmail = response.email
            message = "Enter the six-digit code sent to \(response.email)."
            return response.pending
        } catch {
            message = error.localizedDescription
            return false
        }
    }

    func verifyEmailSignup(code: String) async {
        guard let email = verificationEmail, !isLoading else { return }
        isLoading = true
        message = nil
        defer { isLoading = false }
        do {
            let response: LinkExchangeResponse = try await publicJSON(
                path: "/api/auth/signup/verify",
                method: "POST",
                body: ["email": email, "code": code, "client": "mobile"]
            )
            install(response)
            verificationEmail = nil
            message = "Account created."
        } catch {
            message = error.localizedDescription
        }
    }

    func signInWithGoogle() async {
        if providerStatus?.googleConfigured != true { await loadProviderStatus() }
        guard providerStatus?.googleConfigured == true else {
            message = "Google sign-in is unavailable until the site’s Google provider is configured."
            return
        }
        guard !isLoading else { return }
        isLoading = true
        message = nil
        defer {
            isLoading = false
            googleAuth = nil
        }
        do {
            let startURL = MobileContentEndpoint.baseURL
                .appendingPathComponent("api/auth/google/start")
                .appending(queryItems: [URLQueryItem(name: "client", value: "mobile")])
            let coordinator = GoogleAuthCoordinator()
            googleAuth = coordinator
            let callback = try await coordinator.authenticate(startURL)
            guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value else {
                throw AccountStoreError.invalidResponse
            }
            let response: LinkExchangeResponse = try await publicJSON(
                path: "/api/auth/google/mobile-exchange",
                method: "POST",
                body: ["code": code]
            )
            install(response)
            message = "Signed in with Google."
        } catch is ASWebAuthenticationSessionError {
            message = "Google sign-in was cancelled."
        } catch {
            message = error.localizedDescription
        }
    }

    func startLinking() async {
        guard !isLinking else { return }
        isLinking = true
        message = nil
        defer {
            isLinking = false
            pendingLink = nil
        }
        do {
            let start: LinkStartResponse = try await decodeJSON(
                path: "/api/mobile/link/start",
                method: "POST"
            )
            guard start.approvalURL.scheme?.lowercased() == "https",
                  start.approvalURL.host?.lowercased() == MobileContentEndpoint.baseURL.host?.lowercased(),
                  start.approvalURL.path == "/mobile-link" else {
                throw AccountStoreError.invalidResponse
            }
            pendingLink = PendingMobileLink(code: start.pairingCode, expiresAt: start.expiresAt)
            guard await UIApplication.shared.open(start.approvalURL) else {
                throw AccountStoreError.server("The website could not be opened. Try again when you’re online.")
            }

            for _ in 0..<150 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                try Task.checkCancellation()
                var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent("api/mobile/link/exchange"))
                request.httpMethod = "POST"
                request.timeoutInterval = 15
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "requestId": start.requestId,
                    "pairingSecret": start.pairingSecret,
                ])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else { throw AccountStoreError.invalidResponse }
                if httpResponse.statusCode == 202 { continue }
                if httpResponse.statusCode == 410 { throw AccountStoreError.server("This link expired. Start a new one.") }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw try decodeAPIError(data, statusCode: httpResponse.statusCode)
                }
                let exchange = try JSONDecoder().decode(LinkExchangeResponse.self, from: data)
                session = MobileSession(
                    accessToken: exchange.accessToken,
                    refreshToken: exchange.refreshToken,
                    accessExpiresAt: exchange.accessExpiresAt,
                    refreshExpiresAt: exchange.refreshExpiresAt
                )
                SecureMobileSessionStore.save(session)
                profile = makeProfile(exchange.profile)
                message = "Phone linked."
                return
            }
            throw AccountStoreError.server("The link timed out. Start again when you’re ready.")
        } catch is CancellationError {
            message = "Linking cancelled."
        } catch {
            message = error.localizedDescription
        }
    }

    func signOut() async {
        if let current = session {
            let accessToken: String
            if isExpired(current.accessExpiresAt), let refreshed = try? await refreshSession() {
                accessToken = refreshed.accessToken
            } else {
                accessToken = current.accessToken
            }
            var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent("api/mobile/session/revoke"))
            request.httpMethod = "POST"
            request.timeoutInterval = 10
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            _ = try? await URLSession.shared.data(for: request)
        }
        session = nil
        profile = nil
        emailChangeTarget = nil
        SecureMobileSessionStore.clear()
        message = "Signed out on this device."
    }

    private func makeProfile(_ response: ProfileResponse) -> SharedAccountProfile {
        SharedAccountProfile(
            hasProfile: response.hasProfile ?? true,
            tags: response.tags ?? [],
            email: response.email ?? "",
            displayName: response.displayName ?? "what’s popular? member",
            updatedAt: response.updatedAt,
            username: response.username ?? "",
            emailVerified: response.emailVerified ?? false,
            canEditIdentity: response.canEditIdentity ?? false
        )
    }

    private func install(_ response: LinkExchangeResponse) {
        let next = MobileSession(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            accessExpiresAt: response.accessExpiresAt,
            refreshExpiresAt: response.refreshExpiresAt
        )
        session = next
        SecureMobileSessionStore.save(next)
        profile = makeProfile(response.profile)
    }

    private func authorizedJSON<T: Decodable>(
        path: String,
        method: String,
        body: [String: Any]? = nil
    ) async throws -> T {
        guard session != nil else { throw AccountStoreError.notLinked }
        let activeSession = try await activeAccessSession()
        do {
            return try await sendJSON(path: path, method: method, body: body, session: activeSession)
        } catch AccountStoreError.server(let message) where message == "__UNAUTHORIZED__" {
            let refreshed = try await refreshSession()
            return try await sendJSON(path: path, method: method, body: body, session: refreshed)
        }
    }

    private func activeAccessSession() async throws -> MobileSession {
        guard let current = session else { throw AccountStoreError.notLinked }
        return isExpired(current.accessExpiresAt) ? try await refreshSession() : current
    }

    private func sendJSON<T: Decodable>(path: String, method: String, body: [String: Any]?, session: MobileSession?) async throws -> T {
        var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let session { request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw AccountStoreError.invalidResponse }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw try decodeAPIError(data, statusCode: httpResponse.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw AccountStoreError.invalidResponse }
    }

    private func decodeJSON<T: Decodable>(path: String, method: String) async throws -> T {
        var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw AccountStoreError.invalidResponse }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw try decodeAPIError(data, statusCode: httpResponse.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw AccountStoreError.invalidResponse }
    }

    private func publicJSON<T: Decodable>(path: String, method: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw AccountStoreError.invalidResponse }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw try decodeAPIError(data, statusCode: httpResponse.statusCode)
        }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw AccountStoreError.invalidResponse }
    }

    private func refreshSession() async throws -> MobileSession {
        if let refreshTask {
            return try await refreshTask.value
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { throw AccountStoreError.notLinked }
            return try await self.performRefresh()
        }
        refreshTask = task
        do {
            let refreshed = try await task.value
            refreshTask = nil
            return refreshed
        } catch {
            refreshTask = nil
            throw error
        }
    }

    private func performRefresh() async throws -> MobileSession {
        guard let current = session else { throw AccountStoreError.notLinked }
        var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent("api/mobile/session/refresh"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refreshToken": current.refreshToken])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw AccountStoreError.invalidResponse }
        guard (200..<300).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 {
                session = nil
                profile = nil
                SecureMobileSessionStore.clear()
            }
            throw try decodeAPIError(data, statusCode: httpResponse.statusCode)
        }
        let refreshed = try JSONDecoder().decode(LinkExchangeResponse.self, from: data)
        let next = MobileSession(
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            accessExpiresAt: refreshed.accessExpiresAt,
            refreshExpiresAt: refreshed.refreshExpiresAt
        )
        session = next
        SecureMobileSessionStore.save(next)
        profile = makeProfile(refreshed.profile)
        return next
    }

    private func isExpired(_ value: String) -> Bool {
        guard let date = ISO8601DateFormatter().date(from: value) else { return true }
        return date.timeIntervalSinceNow < 30
    }

    private func decodeAPIError(_ data: Data, statusCode: Int) throws -> AccountStoreError {
        if statusCode == 401 { return .server("__UNAUTHORIZED__") }
        if statusCode == 409 {
            if let payload = try? JSONDecoder().decode(APIErrorPayload.self, from: data), payload.conflict == true {
                return .conflict
            }
        }
        let message = (try? JSONDecoder().decode(APIErrorPayload.self, from: data))?.error
        return .server(message ?? "The account service returned an error (\(statusCode)).")
    }
}

private final class GoogleAuthCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let nextSession = ASWebAuthenticationSession(url: url, callbackURLScheme: "whatspopular") { [weak self] callback, error in
                self?.session = nil
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(throwing: AccountStoreError.invalidResponse)
                }
            }
            session = nextSession
            nextSession.presentationContextProvider = self
            nextSession.prefersEphemeralWebBrowserSession = false
            if !nextSession.start() {
                session = nil
                continuation.resume(throwing: AccountStoreError.server("Google sign-in could not be opened."))
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private enum SecureMobileSessionStore {
    private static let service = "com.whatspopular.mobile.account"
    private static let account = "mobile-session"

    static func load() -> MobileSession? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(MobileSession.self, from: data)
    }

    static func save(_ session: MobileSession?) {
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            var item = query
            item.merge(attributes) { _, new in new }
            SecItemAdd(item as CFDictionary, nil)
        }
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
