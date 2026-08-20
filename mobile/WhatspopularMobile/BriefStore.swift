import Foundation

enum MobileContentEndpoint {
    // This is the stable public Sites URL for the deployed briefing.
    static let baseURL = URL(string: "https://whatspopular.pigeonflare.chatgpt.site")!
    static let snapshotURL = baseURL.appendingPathComponent("data/trends.json")

    static func imageURL(for path: String, revision: String?) -> URL? {
        guard path.range(of: #"^/culture/[a-z0-9-]+\.webp$"#, options: .regularExpression) != nil else {
            return nil
        }
        var components = URLComponents(
            url: baseURL.appendingPathComponent(String(path.dropFirst())),
            resolvingAgainstBaseURL: false
        )
        if let revision, !revision.isEmpty {
            components?.queryItems = [URLQueryItem(name: "v", value: revision)]
        }
        return components?.url
    }
}

@MainActor
final class BriefStore: ObservableObject {
    @Published private(set) var brief: CultureBrief?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isUsingRemoteSnapshot = false
    @Published private(set) var isRefreshing = false

    private let refreshInterval: TimeInterval = 12 * 60 * 60
    private let retryInterval: TimeInterval = 15 * 60
    private let lastSuccessKey = "whatspopular-mobile-last-refresh"
    private let lastAttemptKey = "whatspopular-mobile-last-refresh-attempt"

    init() {
        loadInitialBrief()
    }

    func refreshIfNeeded(force: Bool = false) async {
        guard !isRefreshing else { return }

        let now = Date()
        let lastSuccess = UserDefaults.standard.object(forKey: lastSuccessKey) as? Date
        let lastAttempt = UserDefaults.standard.object(forKey: lastAttemptKey) as? Date
        if !force {
            if let lastSuccess, now.timeIntervalSince(lastSuccess) < refreshInterval { return }
            if let lastAttempt, now.timeIntervalSince(lastAttempt) < retryInterval { return }
        }

        isRefreshing = true
        UserDefaults.standard.set(now, forKey: lastAttemptKey)
        defer { isRefreshing = false }

        do {
            var request = URLRequest(url: MobileContentEndpoint.snapshotURL)
            request.cachePolicy = .useProtocolCachePolicy
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }

            let nextBrief = try decodeAndValidate(data)
            if let cacheURL = cachedSnapshotURL {
                try? FileManager.default.createDirectory(
                    at: cacheURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? data.write(to: cacheURL, options: .atomic)
            }
            brief = nextBrief
            isUsingRemoteSnapshot = true
            errorMessage = nil
            UserDefaults.standard.set(now, forKey: lastSuccessKey)
        } catch {
            if brief == nil {
                errorMessage = "The culture briefing could not be loaded."
            }
        }
    }

    private func loadInitialBrief() {
        if let cacheURL = cachedSnapshotURL,
           let data = try? Data(contentsOf: cacheURL),
           let cachedBrief = try? decodeAndValidate(data) {
            brief = cachedBrief
            isUsingRemoteSnapshot = true
            return
        }

        guard let url = Bundle.main.url(forResource: "trends", withExtension: "json") else {
            errorMessage = "The bundled culture briefing is missing."
            return
        }

        do {
            brief = try decodeAndValidate(Data(contentsOf: url))
        } catch {
            errorMessage = "The bundled culture briefing could not be read."
        }
    }

    private func decodeAndValidate(_ data: Data) throws -> CultureBrief {
        let decoded = try JSONDecoder().decode(CultureBrief.self, from: data)
        guard !decoded.sections.isEmpty,
              decoded.sections.allSatisfy({ !$0.items.isEmpty && $0.allItems.allSatisfy { $0.image.hasPrefix("/culture/") } }),
              !decoded.quiz.questions.isEmpty else {
            throw URLError(.cannotParseResponse)
        }
        return decoded
    }

    private var cachedSnapshotURL: URL? {
        guard let cachesURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        return cachesURL.appendingPathComponent("whatspopular/trends.json")
    }
}
