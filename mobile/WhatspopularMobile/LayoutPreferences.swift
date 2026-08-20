import SwiftUI
import UIKit

enum BoardFormat: String, CaseIterable, Codable, Equatable {
    case compactRows
    case fullCards

    var label: String {
        switch self {
        case .compactRows: "Compact rows"
        case .fullCards: "Full cards"
        }
    }
}

enum DescriptionStyle: String, CaseIterable, Codable, Equatable {
    case hidden
    case concise
    case full

    var label: String {
        switch self {
        case .hidden: "Titles only"
        case .concise: "Concise"
        case .full: "Full context"
        }
    }
}

enum ExpansionStyle: String, CaseIterable, Codable, Equatable {
    case topThree
    case all

    var label: String {
        switch self {
        case .topThree: "Expand top 3"
        case .all: "Expand every entry"
        }
    }
}

struct BoardPreference: Codable, Equatable {
    var accentHex: String
    var format: BoardFormat
    var descriptionStyle: DescriptionStyle
    var expansion: ExpansionStyle
}

final class LayoutPreferences: ObservableObject {
    static let defaultOrder = ["people", "movies", "books", "music", "products", "news", "memes", "slang"]

    @Published private(set) var order: [String]
    @Published private(set) var styles: [String: BoardPreference]

    private let storageKey = "whatspopular-mobile-layout"

    init() {
        order = Self.defaultOrder
        styles = [:]
        load()
    }

    func synchronize(with sections: [CultureSection]) {
        let ids = sections.map(\.id)
        var nextOrder = order.filter(ids.contains)
        nextOrder.append(contentsOf: ids.filter { !nextOrder.contains($0) })

        var nextStyles = styles
        for section in sections where nextStyles[section.id] == nil {
            nextStyles[section.id] = Self.defaultPreference(for: section.id)
        }
        nextStyles = nextStyles.filter { ids.contains($0.key) }

        if nextOrder != order || nextStyles != styles {
            order = nextOrder
            styles = nextStyles
            save()
        }
    }

    func preference(for id: String) -> BoardPreference {
        styles[id] ?? Self.defaultPreference(for: id)
    }

    func move(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        var nextOrder = order
        nextOrder.move(fromOffsets: offsets, toOffset: destination)
        order = nextOrder
        save()
    }

    func updatePreference(for id: String, _ update: (inout BoardPreference) -> Void) {
        var next = preference(for: id)
        update(&next)
        styles[id] = next
        save()
    }

    func reset() {
        order = Self.defaultOrder
        styles = [:]
        save()
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let saved = try? JSONDecoder().decode(SavedLayout.self, from: data) else { return }
        order = saved.order
        styles = saved.styles
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(SavedLayout(order: order, styles: styles)) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    private struct SavedLayout: Codable {
        let order: [String]
        let styles: [String: BoardPreference]
    }

    static func defaultPreference(for id: String) -> BoardPreference {
        let defaults: [String: String] = [
            "people": "#F0A202",
            "movies": "#8B5CF6",
            "books": "#E86A92",
            "music": "#F97316",
            "products": "#0FA3B1",
            "news": "#3B82F6",
            "memes": "#E879F9",
            "slang": "#65A30D"
        ]
        return BoardPreference(
            accentHex: defaults[id] ?? "#6F48E5",
            format: .fullCards,
            descriptionStyle: .concise,
            expansion: .topThree
        )
    }
}

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)
        let red = Double((value >> 16) & 0xff) / 255
        let green = Double((value >> 8) & 0xff) / 255
        let blue = Double(value & 0xff) / 255
        self.init(red: red, green: green, blue: blue)
    }

    var hexValue: String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return "#6F48E5"
        }
        return String(format: "#%02X%02X%02X", Int(red * 255), Int(green * 255), Int(blue * 255))
    }
}
