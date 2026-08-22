import Foundation

struct NichePlayback: Codable, Equatable {
    let provider: String
    let kind: String?
    let externalUrl: String
    let embedUrl: String
    let label: String
}

struct NichePopularityEvidence: Codable, Equatable {
    let mode: String
    let coverageCount: Int
    let coverageSources: [String]
    let signal: String
}

struct NicheTopic: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let description: String
    let whyNow: String
    let url: String
    let source: String
    let sourceLabel: String
    let image: String
    let accent: String
    let trendLabel: String
    let playback: NichePlayback?
    let imageAlt: String?
    let coverageCount: Int?
    let coverageSources: [String]?
    let popularityEvidence: NichePopularityEvidence?
    let publishedAt: String?
}

struct NicheCategory: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    let parent: String
    let description: String
    let accent: String
    let topics: [NicheTopic]
}

struct NicheBrief: Codable, Equatable {
    let generatedAt: String
    let edition: String
    let window: String
    let summary: String
    let categories: [NicheCategory]
}

@MainActor
final class NicheStore: ObservableObject {
    @Published private(set) var brief: NicheBrief?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRefreshing = false

    func refreshIfNeeded() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            var request = URLRequest(url: MobileContentEndpoint.baseURL.appendingPathComponent("api/niche"))
            request.cachePolicy = .useProtocolCachePolicy
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(NicheBrief.self, from: data)
            guard decoded.categories.count >= 3,
                  decoded.categories.allSatisfy({ category in
                      !category.id.isEmpty
                      && !category.topics.isEmpty
                      && category.topics.allSatisfy { topic in
                          guard topic.image.range(of: #"^/culture/[a-z0-9-]+\.webp$"#, options: .regularExpression) != nil,
                                topic.description.trimmingCharacters(in: .whitespacesAndNewlines).count >= 30,
                                topic.whyNow.trimmingCharacters(in: .whitespacesAndNewlines).count >= 20,
                                let url = URL(string: topic.url),
                                url.scheme?.lowercased() == "https",
                                url.user == nil,
                                url.password == nil,
                                url.port == nil,
                                let host = url.host?.lowercased(),
                                !host.isEmpty,
                                !host.hasSuffix(".local"),
                                !host.hasSuffix(".internal"),
                                !host.hasSuffix(".lan") else { return false }
                          if let playback = topic.playback, !Self.isSafePlayback(playback) { return false }
                          return true
                      }
                  }) else {
                throw URLError(.cannotParseResponse)
            }
            brief = decoded
            errorMessage = nil
        } catch {
            if brief == nil { errorMessage = "Your niche digest could not be loaded." }
        }
    }

    private static func isSafePlayback(_ playback: NichePlayback) -> Bool {
        guard let external = URL(string: playback.externalUrl),
              let embed = URL(string: playback.embedUrl),
              external.scheme?.lowercased() == "https",
              embed.scheme?.lowercased() == "https",
              external.user == nil,
              external.password == nil,
              external.port == nil,
              embed.user == nil,
              embed.password == nil,
              embed.port == nil,
              let externalHost = external.host?.lowercased(),
              let embedHost = embed.host?.lowercased() else { return false }

        switch playback.provider {
        case "Spotify":
            return externalHost == "open.spotify.com" && embedHost == "open.spotify.com"
        case "YouTube":
            return ["youtube.com", "www.youtube.com", "youtu.be"].contains(externalHost)
                && ["www.youtube.com", "www.youtube-nocookie.com"].contains(embedHost)
        case "SoundCloud":
            return ["soundcloud.com", "www.soundcloud.com"].contains(externalHost)
                && embedHost == "w.soundcloud.com"
        case "Apple Music":
            return externalHost == "music.apple.com" && embedHost == "embed.music.apple.com"
        default:
            return false
        }
    }
}
