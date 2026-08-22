import SwiftUI
import UIKit
import WebKit

struct ForYouMobileView: View {
    @ObservedObject var account: AccountStore
    @ObservedObject var nicheStore: NicheStore
    @Binding var accountPresented: Bool
    @Binding var selectedTab: Int

    @State private var selectedTags: [String] = []
    @State private var mixRevision = 0

    private let defaultTags = ["edm", "football", "gaming"]

    init(
        account: AccountStore,
        nicheStore: NicheStore,
        accountPresented: Binding<Bool>,
        selectedTab: Binding<Int>
    ) {
        self._account = ObservedObject(wrappedValue: account)
        self._nicheStore = ObservedObject(wrappedValue: nicheStore)
        self._accountPresented = accountPresented
        self._selectedTab = selectedTab
    }

    private var brief: NicheBrief? { nicheStore.brief }
    private var categories: [NicheCategory] { brief?.categories ?? [] }
    private var selectedCategories: [NicheCategory] {
        categories.filter { selectedTags.contains($0.id) }
    }
    private var digestEntries: [MobileDigestEntry] {
        var seen = Set<String>()
        let uniqueEntries = selectedCategories.flatMap { category in
            category.topics.compactMap { topic -> MobileDigestEntry? in
                guard seen.insert(topic.id).inserted else { return nil }
                return MobileDigestEntry(
                    topic: topic,
                    categoryLabel: category.label,
                    categoryParent: category.parent
                )
            }
        }

        return uniqueEntries
            .sorted { stableScore(for: $0.id) < stableScore(for: $1.id) }
            .prefix(16)
            .map { $0 }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let brief {
                    if account.isLinked && !digestEntries.isEmpty {
                        fullScreenFeed(entries: digestEntries)
                    } else {
                        setupView(brief: brief)
                    }
                } else if let errorMessage = nicheStore.errorMessage {
                    ContentUnavailableView("Digest unavailable", systemImage: "sparkles", description: Text(errorMessage))
                } else {
                    ProgressView("Loading your digest…")
                        .frame(maxWidth: .infinity, minHeight: 300)
                }
            }
            .navigationBarHidden(true)
        }
        .onAppear {
            if selectedTags.isEmpty {
                selectedTags = account.presentedProfile?.tags
                    ?? defaultTags.filter { defaultID in categories.contains(where: { $0.id == defaultID }) }
            }
        }
        .onChange(of: account.presentedProfile?.tags ?? []) { _, tags in
            selectedTags = tags
            mixRevision += 1
        }
        .onChange(of: categories) { _, nextCategories in
            let valid = Set(nextCategories.map(\.id))
            let nextTags = selectedTags.filter(valid.contains)
            let fallbackTags = defaultTags.filter(valid.contains)
            let resolvedTags = nextTags.isEmpty ? fallbackTags : nextTags
            if resolvedTags != selectedTags {
                selectedTags = resolvedTags
                mixRevision += 1
            }
        }
    }

    private func setupView(brief: NicheBrief) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 15) {
                header
                tagPicker(categories: brief.categories)
                if account.isLinked {
                    emptySelection
                } else {
                    accountGate
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 42)
        }
        .scrollIndicators(.hidden)
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text("FOR YOU")
                    .font(.caption2.weight(.black))
                    .tracking(1.1)
                    .foregroundStyle(Color(hex: "#6F48E5"))
                Text("Your week,\nmore specific.")
                    .font(.system(size: 31, weight: .black, design: .rounded))
                    .tracking(-1.2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(brief?.summary ?? "A pre-built signal mix from the corners you actually follow.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button { accountPresented = true } label: {
                Image(systemName: account.isLinked ? "person.crop.circle.fill" : "person.crop.circle.badge.plus")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color(hex: "#6F48E5"))
                    .frame(width: 42, height: 42)
                    .background(.regularMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(account.isLinked ? "Open account settings" : "Link account")
        }
        .padding(.vertical, 5)
    }

    private func tagPicker(categories: [NicheCategory]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("Tune the signal")
                    .font(.subheadline.weight(.black))
                Spacer()
                Text("\(selectedTags.count) selected")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(categories) { category in
                        let active = selectedTags.contains(category.id)
                        Button {
                            let next = active
                                ? selectedTags.filter { $0 != category.id }
                                : selectedTags + [category.id]
                            selectedTags = next
                            mixRevision += 1
                            if account.isLinked {
                                Task { await account.saveTags(next) }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Circle().fill(Color(hex: category.accent)).frame(width: 7, height: 7)
                                Text(category.label)
                                    .font(.caption.weight(.bold))
                            }
                            .padding(.horizontal, 11)
                            .padding(.vertical, 8)
                            .foregroundStyle(active ? .white : .primary)
                            .background(active ? Color(hex: category.accent) : Color(.secondarySystemGroupedBackground), in: Capsule())
                            .overlay { Capsule().stroke(Color(hex: category.accent).opacity(active ? 0 : 0.35), lineWidth: 1) }
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(13)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }

    private func fullScreenFeed(entries: [MobileDigestEntry]) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        MobileDigestCard(entry: entry, number: index + 1)
                            .frame(maxWidth: .infinity)
                            .containerRelativeFrame(.vertical)
                            .id(feedID(for: entry))
                    }

                    MobileDigestEndCard(
                        cardCount: entries.count,
                        onRecompile: { mixRevision += 1 },
                        onEditInterests: { accountPresented = true }
                    )
                    .frame(maxWidth: .infinity)
                    .containerRelativeFrame(.vertical)
                    .id(endFeedID)
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .background(Color.black)
            .overlay(alignment: .top) {
                feedHeader(cardCount: entries.count)
            }
            .id(mixRevision)
            .onChange(of: mixRevision) { _, _ in
                guard let firstEntry = entries.first else { return }
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.35)) {
                        proxy.scrollTo(feedID(for: firstEntry), anchor: .top)
                    }
                }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .ignoresSafeArea(.container, edges: .vertical)
    }

    private func feedHeader(cardCount: Int) -> some View {
        HStack(spacing: 11) {
            Button { selectedTab = 1 } label: {
                Image(systemName: "square.grid.2x2")
                    .font(.headline.weight(.bold))
                    .frame(width: 38, height: 38)
                    .background(.white.opacity(0.16), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open Explore")

            VStack(alignment: .leading, spacing: 2) {
                Text("FOR YOU")
                    .font(.caption2.weight(.black))
                    .tracking(1.2)
                Text("\(cardCount) signals · swipe up to keep going")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.8))
            }
            Spacer(minLength: 0)
            Button { accountPresented = true } label: {
                Image(systemName: account.isLinked ? "person.crop.circle.fill" : "person.crop.circle.badge.plus")
                    .font(.title3.weight(.semibold))
                    .frame(width: 38, height: 38)
                    .background(.white.opacity(0.16), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open account settings")
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 19)
        .foregroundStyle(.white)
        .background(
            LinearGradient(
                colors: [.black.opacity(0.72), .black.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private var accountGate: some View {
        VStack(alignment: .leading, spacing: 11) {
            Label("SYNC YOUR SIGNAL", systemImage: "lock.shield")
                .font(.caption2.weight(.black))
                .tracking(0.8)
            Text("Sign in once, then your digest follows you.")
                .font(.title3.weight(.black))
            Text("Use Google or create an email account directly in the app. Your session stays in the iPhone Keychain, never in UserDefaults.")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.84))
            Button { accountPresented = true } label: {
                Text("Open profile")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color(hex: "#4F2EB8"))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.white, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(17)
        .foregroundStyle(.white)
        .background(LinearGradient(colors: [Color(hex: "#6F48E5"), Color(hex: "#4F2EB8")], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var emptySelection: some View {
        ContentUnavailableView("Choose a corner", systemImage: "slider.horizontal.3", description: Text("Pick at least one interest above to compile your weekly cards."))
    }

    private var endFeedID: String { "feed-end-\(mixRevision)" }

    private func feedID(for entry: MobileDigestEntry) -> String {
        "feed-\(mixRevision)-\(entry.id)"
    }

    private func stableScore(for id: String) -> UInt64 {
        let seed = "\(brief?.generatedAt ?? "")|\(selectedTags.joined(separator: ","))|\(mixRevision)|\(id)"
        return seed.utf8.reduce(UInt64(1469598103934665603)) { hash, byte in
            (hash ^ UInt64(byte)) &* 1099511628211
        }
    }
}

private struct MobileDigestEntry: Identifiable {
    let topic: NicheTopic
    let categoryLabel: String
    let categoryParent: String

    var id: String { topic.id }
}

private struct MobileDigestCard: View {
    let entry: MobileDigestEntry
    let number: Int

    private var topic: NicheTopic { entry.topic }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Color(hex: topic.accent)
                if let url = MobileContentEndpoint.imageURL(for: topic.image, revision: nil) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image
                                .resizable()
                                .scaledToFill()
                                .frame(width: geometry.size.width, height: geometry.size.height)
                                .clipped()
                                .opacity(0.64)
                        }
                    }
                }
                LinearGradient(
                    colors: [.black.opacity(0.04), .black.opacity(0.18), .black.opacity(0.9)],
                    startPoint: .top,
                    endPoint: .bottom
                )

                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 10) {
                        Text(String(format: "%02d", number))
                            .font(.system(size: 20, weight: .black, design: .rounded))
                        Spacer(minLength: 0)
                        Text(topic.trendLabel.uppercased())
                            .font(.caption2.weight(.black))
                            .tracking(0.9)
                            .multilineTextAlignment(.trailing)
                    }
                    .foregroundStyle(.white)

                    Spacer(minLength: 14)

                    VStack(alignment: .leading, spacing: 11) {
                        HStack(spacing: 7) {
                            Text(entry.categoryParent.uppercased())
                                .font(.caption2.weight(.black))
                                .tracking(0.9)
                            Text("·")
                                .foregroundStyle(.white.opacity(0.6))
                            Text(entry.categoryLabel.uppercased())
                                .font(.caption2.weight(.black))
                                .tracking(0.9)
                                .lineLimit(1)
                        }
                        .foregroundStyle(Color(hex: topic.accent).opacity(0.95))

                        Text(topic.title)
                            .font(.system(size: 34, weight: .black, design: .rounded))
                            .tracking(-1.05)
                            .lineLimit(6)
                            .minimumScaleFactor(0.68)
                            .fixedSize(horizontal: false, vertical: true)

                        Text(topic.description)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(.white.opacity(0.9))
                            .fixedSize(horizontal: false, vertical: true)

                        VStack(alignment: .leading, spacing: 5) {
                            Text("WHY NOW")
                                .font(.caption2.weight(.black))
                                .tracking(1)
                                .foregroundStyle(Color(hex: topic.accent).opacity(0.95))
                            Text(topic.whyNow)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if let evidence = topic.popularityEvidence,
                           !evidence.signal.isEmpty,
                           normalized(evidence.signal) != normalized(topic.whyNow) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("WHAT PEOPLE ARE FOLLOWING")
                                    .font(.caption2.weight(.black))
                                    .tracking(1)
                                    .foregroundStyle(Color(hex: topic.accent).opacity(0.95))
                                Text(evidence.signal)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(.white.opacity(0.88))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        if let coverageSources = topic.coverageSources,
                           !coverageSources.isEmpty {
                            Text("Reported by \(coverageSources.prefix(3).joined(separator: " · "))")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.68))
                                .lineLimit(2)
                        }

                        if let playback = topic.playback {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(playback.label, systemImage: "play.circle.fill")
                                    .font(.caption2.weight(.black))
                                    .tracking(0.6)
                                NicheMusicEmbedView(playback: playback)
                                    .frame(height: 142)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .padding(9)
                            .background(.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        }

                        if let url = URL(string: topic.url), url.scheme?.lowercased() == "https" {
                            Link(destination: url) {
                                HStack {
                                    Text(topic.sourceLabel)
                                    Spacer(minLength: 8)
                                    Text(topic.source)
                                    Image(systemName: "arrow.up.right")
                                }
                                .font(.caption.weight(.bold))
                                .padding(.top, 9)
                                .overlay(alignment: .top) {
                                    Rectangle().fill(.white.opacity(0.4)).frame(height: 1)
                                }
                            }
                        }
                    }
                    .padding(18)
                    .foregroundStyle(.white)
                    .background(.black.opacity(0.64), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                }
                .padding(.horizontal, 16)
                .padding(.top, 58)
                .padding(.bottom, 22)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Card \(number): \(topic.title)")
    }

    private func normalized(_ value: String) -> String {
        value.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .joined(separator: " ")
            .split(separator: " ")
            .joined(separator: " ")
    }
}

private struct MobileDigestEndCard: View {
    let cardCount: Int
    let onRecompile: () -> Void
    let onEditInterests: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("✦")
                    .font(.title.weight(.bold))
                Spacer()
                Text("END OF MIX")
                    .font(.caption2.weight(.black))
                    .tracking(1.2)
            }

            Spacer()

            Text("You’re all caught up.")
                .font(.system(size: 43, weight: .black, design: .rounded))
                .tracking(-1.3)
            Text("That’s the end of this \(cardCount)-card signal. Swipe down to revisit anything you want to read again.")
                .font(.body.weight(.medium))
                .foregroundStyle(.white.opacity(0.82))

            Button(action: onRecompile) {
                Label("Recompile this mix", systemImage: "shuffle")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .foregroundStyle(Color(hex: "#4F2EB8"))
                    .background(.white, in: Capsule())
            }
            .buttonStyle(.plain)

            Button(action: onEditInterests) {
                Label("Edit interests", systemImage: "slider.horizontal.3")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(.white)
                    .background(.white.opacity(0.16), in: Capsule())
            }
            .buttonStyle(.plain)

            Spacer()
        }
        .padding(.horizontal, 25)
        .padding(.vertical, 34)
        .foregroundStyle(.white)
        .background(
            LinearGradient(
                colors: [Color(hex: "#6F48E5"), Color(hex: "#342070"), .black],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }
}

private struct NicheMusicEmbedView: UIViewRepresentable {
    let playback: NichePlayback

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = [.audio, .video]

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.showsVerticalScrollIndicator = false
        loadIfNeeded(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        loadIfNeeded(webView)
    }

    private func loadIfNeeded(_ webView: WKWebView) {
        let identifier = "niche-music-player-\(playback.provider)-\(playback.embedUrl)"
        guard webView.accessibilityIdentifier != identifier,
              let url = URL(string: playback.embedUrl) else { return }
        webView.accessibilityIdentifier = identifier
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy))
    }
}
