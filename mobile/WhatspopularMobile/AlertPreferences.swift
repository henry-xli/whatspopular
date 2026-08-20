import Foundation
import UserNotifications

@MainActor
final class AlertPreferences: ObservableObject {
    @Published private(set) var notificationsEnabled: Bool
    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var boardUpdateAlerts: Set<String>
    @Published private(set) var entryAlerts: [String: Set<String>]

    private let preferencesKey = "whatspopular-mobile-alert-preferences"
    private let snapshotKey = "whatspopular-mobile-alert-snapshot"

    init() {
        notificationsEnabled = false
        boardUpdateAlerts = []
        entryAlerts = [:]
        load()

        Task {
            await refreshAuthorizationStatus()
        }
    }

    var notificationStatusMessage: String {
        switch authorizationStatus {
        case .denied:
            return "Notifications are blocked. Enable them in iPhone Settings to receive alerts."
        case .notDetermined:
            return "iOS will ask for permission the first time you turn alerts on."
        default:
            return "Alerts are checked whenever the briefing refreshes. iOS may also refresh it in the background."
        }
    }

    func refreshAuthorizationStatus() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        authorizationStatus = status
        if !isAllowed(status), notificationsEnabled {
            notificationsEnabled = false
            save()
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) async {
        if !enabled {
            notificationsEnabled = false
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            save()
            return
        }

        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
            status = await center.notificationSettings().authorizationStatus
            if !granted && status == .notDetermined {
                notificationsEnabled = false
                authorizationStatus = status
                save()
                return
            }
        }

        authorizationStatus = status
        notificationsEnabled = isAllowed(status)
        save()
        if notificationsEnabled {
            BackgroundRefreshScheduler.schedule()
        }
    }

    func isBoardUpdateEnabled(_ sectionID: String) -> Bool {
        boardUpdateAlerts.contains(sectionID)
    }

    func setBoardUpdateEnabled(_ enabled: Bool, for sectionID: String) {
        var next = boardUpdateAlerts
        if enabled {
            next.insert(sectionID)
        } else {
            next.remove(sectionID)
        }
        boardUpdateAlerts = next
        save()
    }

    func isEntryAlertEnabled(sectionID: String, entryID: String) -> Bool {
        entryAlerts[sectionID]?.contains(entryID) == true
    }

    func setEntryAlertEnabled(
        _ enabled: Bool,
        sectionID: String,
        entryID: String,
        title: String
    ) {
        var next = entryAlerts
        var sectionEntries = next[sectionID] ?? []
        if enabled {
            sectionEntries.insert(entryID)
        } else {
            sectionEntries.remove(entryID)
        }
        if sectionEntries.isEmpty {
            next.removeValue(forKey: sectionID)
        } else {
            next[sectionID] = sectionEntries
        }
        entryAlerts = next

        var labels = loadEntryLabels()
        if enabled {
            labels[sectionID, default: [:]][entryID] = title
        } else {
            labels[sectionID]?[entryID] = nil
            if labels[sectionID]?.isEmpty == true {
                labels.removeValue(forKey: sectionID)
            }
        }
        save(entryLabels: labels)
    }

    func selectedEntryCount(for sectionID: String) -> Int {
        entryAlerts[sectionID]?.count ?? 0
    }

    func trackedEntryIDs(for sectionID: String) -> Set<String> {
        entryAlerts[sectionID] ?? []
    }

    func trackedEntryLabel(sectionID: String, entryID: String) -> String {
        loadEntryLabels()[sectionID]?[entryID] ?? entryID.replacingOccurrences(of: "-", with: " ").capitalized
    }

    func clearAllAlerts() {
        boardUpdateAlerts = []
        entryAlerts = [:]
        notificationsEnabled = false
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        save(entryLabels: [:])
    }

    // Seed the comparison without notifying. This prevents the bundled or
    // cached snapshot shown at launch from looking like a new update.
    func seed(brief: CultureBrief) {
        guard loadSnapshot() == nil else { return }
        save(snapshot: AlertSnapshot(brief: brief))
    }

    func process(brief: CultureBrief) {
        let next = AlertSnapshot(brief: brief)
        guard let previous = loadSnapshot() else {
            save(snapshot: next)
            return
        }

        guard previous.generatedAt != next.generatedAt else { return }

        guard notificationsEnabled else {
            save(snapshot: next)
            return
        }

        var messages: [AlertMessage] = []
        let sectionIDs = Set(previous.sections.keys).union(next.sections.keys)

        let updatedBoards = sectionIDs.compactMap { sectionID -> String? in
            guard boardUpdateAlerts.contains(sectionID) else { return nil }
            return next.sections[sectionID]?.title ?? previous.sections[sectionID]?.title
        }.sorted()
        if !updatedBoards.isEmpty {
            messages.append(
                AlertMessage(
                    title: "Leaderboards updated",
                    body: "New briefing data is available for \(list(updatedBoards))."
                )
            )
        }

        for sectionID in sectionIDs.sorted() {
            let tracked = entryAlerts[sectionID] ?? []
            guard !tracked.isEmpty else { continue }

            let oldSection = previous.sections[sectionID]
            let newSection = next.sections[sectionID]
            let oldIDs = Set(oldSection?.itemIDs ?? [])
            let newIDs = Set(newSection?.itemIDs ?? [])
            let added = tracked.filter { !oldIDs.contains($0) && newIDs.contains($0) }
            let removed = tracked.filter { oldIDs.contains($0) && !newIDs.contains($0) }
            guard !added.isEmpty || !removed.isEmpty else { continue }

            let boardTitle = newSection?.title ?? oldSection?.title ?? "Leaderboard"
            var parts: [String] = []
            if !added.isEmpty {
                let titles = added.compactMap { newSection?.entryTitles[$0] }.sorted()
                parts.append("New: \(list(titles))")
            }
            if !removed.isEmpty {
                let titles = removed.compactMap { oldSection?.entryTitles[$0] }.sorted()
                parts.append("Removed: \(list(titles))")
            }
            messages.append(AlertMessage(title: "\(boardTitle) changed", body: parts.joined(separator: "  ")))
        }

        schedule(messages)
        save(snapshot: next)
    }

    private func schedule(_ messages: [AlertMessage]) {
        let center = UNUserNotificationCenter.current()
        for message in messages.prefix(12) {
            let content = UNMutableNotificationContent()
            content.title = message.title
            content.body = message.body
            content.sound = .default

            let request = UNNotificationRequest(
                identifier: "whatspopular-alert-\(UUID().uuidString)",
                content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
            )
            center.add(request)
        }
    }

    private func list(_ values: [String]) -> String {
        let visible = values.prefix(3)
        let names = visible.joined(separator: ", ")
        let remainder = values.count - visible.count
        return remainder > 0 ? "\(names), and \(remainder) more" : names
    }

    private func isAllowed(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: preferencesKey),
              let saved = try? JSONDecoder().decode(SavedPreferences.self, from: data) else {
            return
        }
        notificationsEnabled = saved.notificationsEnabled
        boardUpdateAlerts = Set(saved.boardUpdateAlerts)
        entryAlerts = saved.entryAlerts.reduce(into: [:]) { result, entry in
            result[entry.key] = Set(entry.value)
        }
    }

    private func save(entryLabels: [String: [String: String]]? = nil) {
        let labels = entryLabels ?? loadEntryLabels()
        let saved = SavedPreferences(
            notificationsEnabled: notificationsEnabled,
            boardUpdateAlerts: Array(boardUpdateAlerts).sorted(),
            entryAlerts: entryAlerts.mapValues { Array($0).sorted() },
            entryLabels: labels
        )
        guard let data = try? JSONEncoder().encode(saved) else { return }
        UserDefaults.standard.set(data, forKey: preferencesKey)
    }

    private func loadEntryLabels() -> [String: [String: String]] {
        guard let data = UserDefaults.standard.data(forKey: preferencesKey),
              let saved = try? JSONDecoder().decode(SavedPreferences.self, from: data) else {
            return [:]
        }
        return saved.entryLabels
    }

    private func save(snapshot: AlertSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: snapshotKey)
    }

    private func loadSnapshot() -> AlertSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: snapshotKey) else { return nil }
        return try? JSONDecoder().decode(AlertSnapshot.self, from: data)
    }

    private struct SavedPreferences: Codable {
        let notificationsEnabled: Bool
        let boardUpdateAlerts: [String]
        let entryAlerts: [String: [String]]
        let entryLabels: [String: [String: String]]

        init(
            notificationsEnabled: Bool,
            boardUpdateAlerts: [String],
            entryAlerts: [String: [String]],
            entryLabels: [String: [String: String]] = [:]
        ) {
            self.notificationsEnabled = notificationsEnabled
            self.boardUpdateAlerts = boardUpdateAlerts
            self.entryAlerts = entryAlerts
            self.entryLabels = entryLabels
        }
    }

    private struct AlertSnapshot: Codable {
        let generatedAt: String
        let sections: [String: SectionSnapshot]

        init(brief: CultureBrief) {
            generatedAt = brief.generatedAt
            sections = brief.sections.reduce(into: [:]) { result, section in
                let entries = section.allItems
                result[section.id] = SectionSnapshot(
                    title: section.title,
                    itemIDs: entries.map(\.alertID),
                    entryTitles: Dictionary(uniqueKeysWithValues: entries.map { ($0.alertID, $0.title) })
                )
            }
        }
    }

    private struct SectionSnapshot: Codable {
        let title: String
        let itemIDs: [String]
        let entryTitles: [String: String]
    }

    private struct AlertMessage {
        let title: String
        let body: String
    }
}

final class MobileNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = MobileNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .badge, .sound])
    }
}
