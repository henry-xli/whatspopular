import Foundation

enum CultureLayout: String, Codable {
    case landscape
    case poster
    case square
}

struct CultureMetric: Codable {
    let label: String
    let value: String
}

struct CultureEvidence: Codable {
    let source: String
    let url: String
}

struct CultureItem: Codable, Identifiable {
    let rank: Int
    let title: String
    let subtitle: String
    let description: String
    let image: String
    let alt: String
    let url: String
    let source: String
    let metric: CultureMetric?
    let evidence: [CultureEvidence]
    let accent: String
    let rating: String?
    let ratingLabel: String?
    let spotifyId: String?
    let spotifyRank: Int?
    let releaseDate: String?

    var id: String { "\(rank)-\(title)" }

    // Rank is intentionally excluded so an entry remains trackable when it
    // moves up or down within a leaderboard.
    var alertID: String {
        let normalized = title
            .lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .joined(separator: "-")
        return normalized.isEmpty ? url : normalized
    }
}

struct CultureSource: Codable, Identifiable {
    let label: String
    let url: String

    var id: String { url }
}

struct CultureSection: Codable, Identifiable {
    let id: String
    let eyebrow: String
    let title: String
    let description: String
    let sources: [CultureSource]
    let layout: CultureLayout
    let items: [CultureItem]
    let moreItems: [CultureItem]?
    let moreLabel: String?

    var allItems: [CultureItem] { items + (moreItems ?? []) }
}

struct CultureQuizQuestion: Codable, Identifiable {
    let id: String
    let topicId: String
    let topic: String
    let itemTitle: String
    let prompt: String
    let answers: [String]
    let correctAnswer: String
}

struct CultureQuiz: Codable {
    let durationSeconds: Int
    let questions: [CultureQuizQuestion]
}

struct CultureBrief: Codable {
    let edition: String
    let status: String
    let window: String
    let generatedAt: String
    let summary: String
    let sections: [CultureSection]
    let quiz: CultureQuiz
}
