import Foundation
import Security
import UIKit

struct SharedAccountProfile: Codable, Equatable {
    var hasProfile: Bool
    var tags: [String]
    var email: String
    var displayName: String
    var updatedAt: String?
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

    private var session: MobileSession?
    private var refreshTask: Task<MobileSession, Error>?

    init() {
        session = SecureMobileSessionStore.load()
    }

    var isLinked: Bool { session != nil }

    func bootstrap() async {
        guard session != nil else { return }
        await refreshProfile()
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
        SecureMobileSessionStore.clear()
        message = "Signed out on this device."
    }

    private func makeProfile(_ response: ProfileResponse) -> SharedAccountProfile {
        SharedAccountProfile(
            hasProfile: response.hasProfile ?? true,
            tags: response.tags ?? [],
            email: response.email ?? "",
            displayName: response.displayName ?? "what’s popular? member",
            updatedAt: response.updatedAt
        )
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
