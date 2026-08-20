import Foundation
import SwiftUI

private enum MobileThemeMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

struct ContentView: View {
    @StateObject private var store = BriefStore()
    @StateObject private var preferences = LayoutPreferences()
    @AppStorage("whatspopular-mobile-theme") private var themeRawValue = MobileThemeMode.system.rawValue
    @State private var settingsPresented = false
    @Environment(\.scenePhase) private var scenePhase

    private var preferredColorScheme: ColorScheme? {
        switch MobileThemeMode(rawValue: themeRawValue) ?? .system {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let brief = store.brief {
                    BriefHome(
                        brief: brief,
                        preferences: preferences,
                        settingsPresented: $settingsPresented,
                        remoteImageVersion: store.isUsingRemoteSnapshot ? brief.generatedAt : nil
                    )
                } else if let errorMessage = store.errorMessage {
                    ContentUnavailableView(
                        "Briefing unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(errorMessage)
                    )
                } else {
                    ProgressView("Loading the briefing…")
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .preferredColorScheme(preferredColorScheme)
        .task {
            await store.refreshIfNeeded()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await store.refreshIfNeeded() }
        }
    }
}

private enum BriefScrollTarget {
    static let top = "brief-top"
}

private struct BriefScrollOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct BriefHome: View {
    let brief: CultureBrief
    @ObservedObject var preferences: LayoutPreferences
    @Binding var settingsPresented: Bool
    let remoteImageVersion: String?

    @State private var scrollOffset: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        Color.clear
                            .frame(height: 1)
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(
                                        key: BriefScrollOffsetKey.self,
                                        value: geometry.frame(in: .named("briefScroll")).minY
                                    )
                                }
                            }
                            .id(BriefScrollTarget.top)

                        MobileHeader(brief: brief) {
                            settingsPresented = true
                        }

                        QuizCard(
                            questions: brief.quiz.questions,
                            durationSeconds: brief.quiz.durationSeconds
                        )

                        StandoutRail(sections: brief.sections, remoteImageVersion: remoteImageVersion)

                        ExploreHeader(brief: brief) {
                            settingsPresented = true
                        }

                        LeaderboardJumpBar(sections: brief.sections, order: preferences.order) { id in
                            withAnimation(.easeInOut(duration: 0.35)) {
                                proxy.scrollTo(id, anchor: .top)
                            }
                        }

                        ForEach(preferences.order, id: \.self) { id in
                            if let section = brief.sections.first(where: { $0.id == id }) {
                                MobileLeaderboard(
                                    section: section,
                                    boardNumber: (preferences.order.firstIndex(of: id) ?? 0) + 1,
                                    preference: preferences.preference(for: id),
                                    remoteImageVersion: remoteImageVersion
                                )
                                .id(id)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
                    .padding(.bottom, 72)
                }
                .scrollIndicators(.hidden)

                if scrollOffset < -180 {
                    Button {
                        withAnimation(.easeInOut(duration: 0.35)) {
                            proxy.scrollTo(BriefScrollTarget.top, anchor: .top)
                        }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 42, height: 42)
                            .background(Color(hex: "#6F48E5"), in: Circle())
                            .shadow(color: .black.opacity(0.18), radius: 8, y: 4)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back to top")
                    .padding(.trailing, 16)
                    .padding(.bottom, 62)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .onPreferenceChange(BriefScrollOffsetKey.self) { offset in
                scrollOffset = offset
            }
            .safeAreaInset(edge: .bottom) {
                Text("Tap any entry to open its source")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(.thinMaterial)
            }
            .onAppear {
                preferences.synchronize(with: brief.sections)
            }
            .sheet(isPresented: $settingsPresented) {
                LayoutSettingsSheet(sections: brief.sections, preferences: preferences)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .coordinateSpace(name: "briefScroll")
        }
    }
}

private struct MobileHeader: View {
    let brief: CultureBrief
    let openSettings: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(Color(hex: "#6F48E5"))
                        Image(systemName: "sparkles")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 28, height: 28)

                    Text("what’s popular?")
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                }

                Text("How trendy are you?")
                    .font(.system(size: 25, weight: .black, design: .rounded))
                    .tracking(-1)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)

                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                    Text("\(brief.edition) · \(brief.status)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)

            Button(action: openSettings) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.headline.weight(.semibold))
                        .frame(width: 38, height: 38)
                        .background(.thinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Customize the briefing layout")
        }
    }
}

private struct ExploreHeader: View {
    let brief: CultureBrief
    let openSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Explore")
                        .font(.system(size: 27, weight: .black, design: .rounded))
                    Text("Your briefing, in your order")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button(action: openSettings) {
                    Label("Customize", systemImage: "slider.horizontal.3")
                        .font(.caption.weight(.bold))
                }
                .buttonStyle(.bordered)
                .tint(Color(hex: "#6F48E5"))
            }

            Text(brief.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }
}

private struct LeaderboardJumpBar: View {
    let sections: [CultureSection]
    let order: [String]
    let jumpTo: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Jump to")
                .font(.caption.weight(.black))
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(order, id: \.self) { id in
                        if let section = sections.first(where: { $0.id == id }) {
                            Button {
                                jumpTo(id)
                            } label: {
                                Text(section.title)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(Color(hex: "#5A38C5"))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 7)
                                    .background(Color(hex: "#6F48E5").opacity(0.10), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

private struct StandoutRail: View {
    struct Standout: Identifiable {
        let id: String
        let sectionTitle: String
        let item: CultureItem
    }

    let sections: [CultureSection]
    let remoteImageVersion: String?

    private var standouts: [Standout] {
        sections.compactMap { section in
            guard let item = section.items.first else { return nil }
            return Standout(id: section.id, sectionTitle: section.title, item: item)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Standout", systemImage: "star.fill")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(Color(hex: "#6F48E5"))
                Spacer()
                Text("Top entry in each board")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(standouts) { standout in
                        if let url = URL(string: standout.item.url) {
                            Link(destination: url) {
                                VStack(alignment: .leading, spacing: 8) {
                                    CultureImage(path: standout.item.image, contentMode: .fit, remoteImageVersion: remoteImageVersion)
                                        .frame(width: 148, height: 86)
                                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                                    Text(standout.sectionTitle.uppercased())
                                        .font(.system(size: 9, weight: .black, design: .rounded))
                                        .foregroundStyle(Color(hex: standout.item.accent))
                                        .tracking(0.6)
                                    Text(standout.item.title)
                                        .font(.subheadline.weight(.bold))
                                        .lineLimit(1)
                                    Text(standout.item.description)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                .frame(width: 148, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

private struct MobileLeaderboard: View {
    let section: CultureSection
    let boardNumber: Int
    let preference: BoardPreference
    let remoteImageVersion: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 10) {
                    Text(String(format: "%02d", boardNumber))
                        .font(.caption.weight(.black).monospacedDigit())
                        .foregroundStyle(Color(hex: preference.accentHex))
                    Text(section.title)
                        .font(.system(size: 20, weight: .black, design: .rounded))
                    Spacer()
                    Text("\(section.allItems.count) entries")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }

                Text(section.eyebrow)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                if preference.descriptionStyle != .hidden {
                    Text(displayDescription(section.description, style: preference.descriptionStyle))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(preference.descriptionStyle == .full ? 4 : 2)
                }

                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.bold))
                    Text(section.sources.first?.label ?? "Sources")
                        .lineLimit(1)
                    Text("·")
                    Text(preference.expansion.label)
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(hex: preference.accentHex))
            }

            LazyVStack(spacing: 6) {
                ForEach(section.allItems) { item in
                    let expanded = preference.expansion == .all || item.rank <= 3
                    MobileEntryCard(
                        item: item,
                        layout: section.layout,
                        preference: preference,
                        expanded: expanded,
                        remoteImageVersion: remoteImageVersion
                    )
                }
            }
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color(hex: preference.accentHex).opacity(0.28), lineWidth: 1)
        }
    }

    private func displayDescription(_ description: String, style: DescriptionStyle) -> String {
        guard style == .concise, let end = description.firstIndex(of: ".") else { return description }
        return String(description[...end])
    }
}

private struct MobileEntryCard: View {
    let item: CultureItem
    let layout: CultureLayout
    let preference: BoardPreference
    let expanded: Bool
    let remoteImageVersion: String?

    var body: some View {
        if let url = URL(string: item.url) {
            Link(destination: url) {
                cardContent
            }
            .buttonStyle(.plain)
        } else {
            cardContent
        }
    }

    @ViewBuilder
    private var cardContent: some View {
        if preference.format == .fullCards && expanded {
            fullCard
        } else {
            compactRow
        }
    }

    private var compactRow: some View {
        HStack(spacing: 8) {
            Text(String(format: "%02d", item.rank))
                .font(.caption.weight(.black).monospacedDigit())
                .foregroundStyle(Color(hex: preference.accentHex))
                .frame(width: 22, alignment: .leading)

            CultureImage(path: item.image, contentMode: .fit, remoteImageVersion: remoteImageVersion)
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(item.title)
                        .font(.callout.weight(.bold))
                        .lineLimit(1)
                    if item.rating != nil {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(.yellow)
                    }
                }
                Text(item.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if let metric = item.metric {
                Text(metric.value)
                    .font(.caption.weight(.black).monospacedDigit())
                    .foregroundStyle(Color(hex: preference.accentHex))
                    .lineLimit(1)
            }

            Image(systemName: "arrow.up.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var fullCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                CultureImage(path: item.image, contentMode: .fit, remoteImageVersion: remoteImageVersion)
                    .frame(maxWidth: .infinity)
                    .frame(height: imageHeight)
                    .clipped()

                Text("#\(item.rank)")
                    .font(.caption.weight(.black).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Color(hex: preference.accentHex), in: Capsule())
                    .padding(10)

                HStack {
                    Spacer()
                    Text(item.source)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.58), in: Capsule())
                        .padding(10)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.headline.weight(.bold))
                            .lineLimit(2)
                        Text(item.subtitle)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                }

                if let rating = item.rating {
                    HStack(spacing: 5) {
                        Image(systemName: "star.fill")
                            .foregroundStyle(.yellow)
                        Text(rating)
                            .font(.caption.weight(.bold))
                        Text(item.ratingLabel ?? "Rating")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if preference.descriptionStyle != .hidden {
                    Text(descriptionText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let metric = item.metric {
                    HStack {
                        Text(metric.label)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(metric.value)
                            .font(.subheadline.weight(.black).monospacedDigit())
                            .foregroundStyle(Color(hex: preference.accentHex))
                    }
                    .padding(.top, 2)
                }
            }
            .padding(12)
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private var imageHeight: CGFloat {
        switch layout {
        case .poster: 150
        case .square: 116
        case .landscape: 104
        }
    }

    private var descriptionText: String {
        guard preference.descriptionStyle == .concise,
              let end = item.description.firstIndex(of: ".") else { return item.description }
        return String(item.description[...end])
    }
}

private struct QuizRoundQuestion {
    let question: CultureQuizQuestion
    let answers: [String]
}

private struct QuizCard: View {
    enum Status { case idle, active, complete }

    let questions: [CultureQuizQuestion]
    let durationSeconds: Int

    @State private var status: Status = .idle
    @State private var round: [QuizRoundQuestion] = []
    @State private var current = 0
    @State private var responses: [String?] = []
    @State private var selectedAnswer: String?
    @State private var revealed = false
    @State private var timedOut = false
    @State private var timeRemaining = 15
    @State private var deadline: Date?
    @State private var pendingAdvance: UUID?

    private let timer = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    private var question: QuizRoundQuestion? {
        guard round.indices.contains(current) else { return nil }
        return round[current]
    }

    private var score: Int {
        round.indices.reduce(into: 0) { result, index in
            if responses.indices.contains(index), responses[index] == round[index].question.correctAnswer {
                result += 1
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch status {
            case .idle:
                idleView
            case .active:
                activeView
            case .complete:
                completeView
            }
        }
        .padding(13)
        .background(
            LinearGradient(
                colors: [Color(hex: "#6F48E5"), Color(hex: "#4F2EB8")],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .foregroundStyle(.white)
        .onReceive(timer) { now in
            guard status == .active, !revealed, let deadline else { return }
            let seconds = max(0, Int(ceil(deadline.timeIntervalSince(now))))
            timeRemaining = seconds
            if seconds == 0 {
                timedOut = true
                revealed = true
                scheduleAdvance()
            }
        }
    }

    private var idleView: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("TAKE THE QUIZ", systemImage: "sparkles")
                    .font(.caption.weight(.black))
                    .tracking(0.8)
                Spacer()
                Text("5 questions")
                    .font(.caption.weight(.semibold))
                    .opacity(0.75)
            }

            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("How much do you know?")
                        .font(.subheadline.weight(.black))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Text("A quick pulse check on what’s shaping the moment.")
                        .font(.caption)
                        .opacity(0.82)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                Button(action: start) {
                    Text("Start")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color(hex: "#4F2EB8"))
                        .padding(.horizontal, 13)
                        .padding(.vertical, 8)
                        .background(.white, in: Capsule())
                }
                .fixedSize()
            }
        }
    }

    @ViewBuilder
    private var activeView: some View {
        if let question {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Question \(current + 1) of \(round.count)")
                        .font(.caption.weight(.bold))
                    Spacer()
                    Text("\(timeRemaining)s")
                        .font(.caption.weight(.black).monospacedDigit())
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(timeRemaining <= 5 ? Color.red.opacity(0.8) : Color.white.opacity(0.18), in: Capsule())
                }

                Text(question.question.topic.uppercased())
                    .font(.caption2.weight(.black))
                    .tracking(0.8)
                    .opacity(0.72)
                Text(question.question.prompt)
                    .font(.headline.weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: 8) {
                    ForEach(question.answers, id: \.self) { answer in
                        Button {
                            choose(answer)
                        } label: {
                            HStack {
                                Text(answer)
                                    .font(.subheadline.weight(.semibold))
                                    .multilineTextAlignment(.leading)
                                Spacer()
                                if revealed && answer == question.question.correctAnswer {
                                    Image(systemName: "checkmark.circle.fill")
                                } else if revealed && answer == selectedAnswer {
                                    Image(systemName: "xmark.circle.fill")
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 11)
                            .foregroundStyle(answerColor(answer, correct: question.question.correctAnswer))
                            .background(answerBackground(answer, correct: question.question.correctAnswer), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(revealed)
                    }
                }

                Text(feedback(for: question.question))
                    .font(.caption.weight(.semibold))
                    .opacity(0.8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var completeView: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("QUIZ COMPLETE")
                .font(.caption.weight(.black))
                .tracking(0.8)
            Text("You scored \(score) / \(round.count).")
                .font(.title3.weight(.black))
            Text(score == round.count ? "You are fully caught up." : "Explore the boards to fill in the gaps.")
                .font(.subheadline)
                .opacity(0.82)
            Button("Try again", action: start)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Color(hex: "#4F2EB8"))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.white, in: Capsule())
                .buttonStyle(.plain)
                .padding(.top, 3)
        }
    }

    private func start() {
        let nextRound = questions.shuffled().prefix(5).map {
            QuizRoundQuestion(question: $0, answers: $0.answers.shuffled())
        }
        round = Array(nextRound)
        responses = Array(repeating: nil, count: round.count)
        current = 0
        selectedAnswer = nil
        revealed = false
        timedOut = false
        timeRemaining = durationSeconds
        deadline = Date().addingTimeInterval(Double(durationSeconds))
        status = .active
    }

    private func choose(_ answer: String) {
        guard status == .active, !revealed, let question else { return }
        selectedAnswer = answer
        responses[current] = answer
        revealed = true
        timedOut = false
        _ = question
        scheduleAdvance()
    }

    private func scheduleAdvance() {
        let token = UUID()
        pendingAdvance = token
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.25) {
            guard pendingAdvance == token else { return }
            advance()
        }
    }

    private func advance() {
        pendingAdvance = nil
        guard current < round.count - 1 else {
            deadline = nil
            status = .complete
            return
        }
        current += 1
        selectedAnswer = nil
        revealed = false
        timedOut = false
        timeRemaining = durationSeconds
        deadline = Date().addingTimeInterval(Double(durationSeconds))
    }

    private func feedback(for question: CultureQuizQuestion) -> String {
        if timedOut { return "Time’s up — the next question is coming." }
        if !revealed { return "Choose one answer." }
        return selectedAnswer == question.correctAnswer ? "Correct — nice work." : "Not quite — keep going."
    }

    private func answerColor(_ answer: String, correct: String) -> Color {
        guard revealed else { return .white }
        if answer == correct { return Color.green.opacity(0.95) }
        if answer == selectedAnswer { return Color.red.opacity(0.95) }
        return .white.opacity(0.66)
    }

    private func answerBackground(_ answer: String, correct: String) -> Color {
        guard revealed else { return .white.opacity(0.14) }
        if answer == correct { return Color.green.opacity(0.18) }
        if answer == selectedAnswer { return Color.red.opacity(0.18) }
        return .white.opacity(0.08)
    }
}

private struct LayoutSettingsSheet: View {
    let sections: [CultureSection]
    @ObservedObject var preferences: LayoutPreferences
    @AppStorage("whatspopular-mobile-theme") private var themeRawValue = MobileThemeMode.system.rawValue
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Appearance") {
                    Picker("Color mode", selection: $themeRawValue) {
                        ForEach(MobileThemeMode.allCases) { mode in
                            Text(mode.label).tag(mode.rawValue)
                        }
                    }
                }

                Section {
                    Text("Drag the condensed rows into the order you want to read them. Each board keeps its own color and density settings below.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    ForEach(preferences.order, id: \.self) { id in
                        if let section = section(for: id) {
                            HStack(spacing: 10) {
                                RoundedRectangle(cornerRadius: 4, style: .continuous)
                                    .fill(Color(hex: preferences.preference(for: id).accentHex))
                                    .frame(width: 8, height: 34)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(section.title)
                                        .font(.subheadline.weight(.bold))
                                    Text("\(section.allItems.count) entries · drag to reorder")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "line.3.horizontal")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .onMove(perform: preferences.move)
                } header: {
                    Text("Board order")
                } footer: {
                    Text("Tap Edit, then drag a row up or down.")
                }

                ForEach(preferences.order, id: \.self) { id in
                    if let section = section(for: id) {
                        BoardStyleSection(section: section, preferences: preferences)
                    }
                }

                Section {
                    Button("Reset mobile layout", role: .destructive) {
                        preferences.reset()
                    }
                } footer: {
                    Text("Your choices are saved on this device and do not change the shared website.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Customize")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func section(for id: String) -> CultureSection? {
        sections.first(where: { $0.id == id })
    }
}

private struct BoardStyleSection: View {
    let section: CultureSection
    @ObservedObject var preferences: LayoutPreferences

    var body: some View {
        Section {
            ColorPicker(
                "Board color",
                selection: Binding(
                    get: { Color(hex: preferences.preference(for: section.id).accentHex) },
                    set: { newColor in
                        preferences.updatePreference(for: section.id) { $0.accentHex = newColor.hexValue }
                    }
                ),
                supportsOpacity: false
            )

            Picker(
                "Card format",
                selection: Binding(
                    get: { preferences.preference(for: section.id).format },
                    set: { newValue in
                        preferences.updatePreference(for: section.id) { $0.format = newValue }
                    }
                )
            ) {
                ForEach(BoardFormat.allCases, id: \.self) { format in
                    Text(format.label).tag(format)
                }
            }

            Picker(
                "Descriptions",
                selection: Binding(
                    get: { preferences.preference(for: section.id).descriptionStyle },
                    set: { newValue in
                        preferences.updatePreference(for: section.id) { $0.descriptionStyle = newValue }
                    }
                )
            ) {
                ForEach(DescriptionStyle.allCases, id: \.self) { style in
                    Text(style.label).tag(style)
                }
            }

            Picker(
                "Expanded entries",
                selection: Binding(
                    get: { preferences.preference(for: section.id).expansion },
                    set: { newValue in
                        preferences.updatePreference(for: section.id) { $0.expansion = newValue }
                    }
                )
            ) {
                ForEach(ExpansionStyle.allCases, id: \.self) { style in
                    Text(style.label).tag(style)
                }
            }
        } header: {
            Text(section.title)
        } footer: {
            Text("\(section.title) uses \(preferences.preference(for: section.id).format.label.lowercased()) with \(preferences.preference(for: section.id).expansion.label.lowercased()).")
        }
    }
}
