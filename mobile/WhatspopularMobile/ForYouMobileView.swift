import SwiftUI

struct ForYouMobileView: View {
    @ObservedObject var account: AccountStore
    @ObservedObject var nicheStore: NicheStore
    @Binding var accountPresented: Bool

    @State private var selectedTags: [String] = []
    @State private var activeIndex = 0
    @State private var compiled = false

    private let defaultTags = ["edm", "football", "gaming"]

    private var brief: NicheBrief? { nicheStore.brief }
    private var categories: [NicheCategory] { brief?.categories ?? [] }
    private var selectedCategories: [NicheCategory] { categories.filter { selectedTags.contains($0.id) } }
    private var digestTopics: [NicheTopic] {
        var seen = Set<String>()
        return selectedCategories.flatMap(\.topics).filter { seen.insert($0.id).inserted }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    header
                    if let brief {
                        tagPicker(categories: brief.categories)
                        if account.isLinked && !digestTopics.isEmpty {
                            digestPager(topics: digestTopics)
                        } else if account.isLinked {
                            emptySelection
                        } else {
                            accountGate
                        }
                    } else if let errorMessage = nicheStore.errorMessage {
                        ContentUnavailableView("Digest unavailable", systemImage: "sparkles", description: Text(errorMessage))
                    } else {
                        ProgressView("Loading your digest…")
                            .frame(maxWidth: .infinity, minHeight: 300)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 42)
            }
            .scrollIndicators(.hidden)
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .navigationBarHidden(true)
        }
        .onAppear {
            if selectedTags.isEmpty {
                selectedTags = account.profile?.tags ?? defaultTags.filter { defaultID in categories.contains(where: { $0.id == defaultID }) }
            }
            compiled = account.isLinked
        }
        .onChange(of: account.profile?.tags ?? []) { _, tags in
            selectedTags = tags
            activeIndex = 0
            compiled = account.isLinked
        }
        .onChange(of: categories) { _, nextCategories in
            let valid = Set(nextCategories.map(\.id))
            selectedTags = selectedTags.filter(valid.contains)
            if selectedTags.isEmpty { selectedTags = defaultTags.filter(valid.contains) }
        }
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
                            guard account.isLinked else { accountPresented = true; return }
                            let next = active ? selectedTags.filter { $0 != category.id } : selectedTags + [category.id]
                            selectedTags = next
                            activeIndex = 0
                            Task { await account.saveTags(next) }
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
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(13)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }

    private func digestPager(topics: [NicheTopic]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(compiled ? "THIS WEEK" : "YOUR MIX")
                    .font(.caption2.weight(.black))
                    .tracking(1)
                    .foregroundStyle(Color(hex: "#6F48E5"))
                Spacer()
                Text("\(min(topics.count, 16)) cards")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            TabView(selection: $activeIndex) {
                ForEach(Array(topics.prefix(16).enumerated()), id: \.element.id) { index, topic in
                    MobileDigestCard(topic: topic, number: index + 1)
                        .tag(index)
                        .padding(.bottom, 24)
                }
            }
            .frame(height: 535)
            .tabViewStyle(.page(indexDisplayMode: .automatic))
            .animation(.easeInOut(duration: 0.35), value: activeIndex)
            Button {
                activeIndex = 0
                compiled.toggle()
            } label: {
                Label(compiled ? "Recompile this mix" : "Compile my digest", systemImage: compiled ? "shuffle" : "wand.and.stars")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .foregroundStyle(.white)
                    .background(Color(hex: "#6F48E5"), in: Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private var accountGate: some View {
        VStack(alignment: .leading, spacing: 11) {
            Label("SYNC YOUR SIGNAL", systemImage: "lock.shield")
                .font(.caption2.weight(.black))
                .tracking(0.8)
            Text("Link once, then your digest follows you.")
                .font(.title3.weight(.black))
            Text("The app opens the website for a one-time approval. Your session stays in the iPhone Keychain, never in UserDefaults.")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.84))
            Button { accountPresented = true } label: {
                Text("Link account")
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
}

private struct MobileDigestCard: View {
    let topic: NicheTopic
    let number: Int

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottomLeading) {
                Color(hex: topic.accent)
                if let url = MobileContentEndpoint.imageURL(for: topic.image, revision: nil) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped().opacity(0.72)
                        }
                    }
                }
                LinearGradient(colors: [.clear, .black.opacity(0.82)], startPoint: .top, endPoint: .bottom)
                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        Text(String(format: "%02d", number))
                            .font(.system(size: 18, weight: .black, design: .rounded))
                        Spacer()
                        Text(topic.trendLabel.uppercased())
                            .font(.caption2.weight(.black))
                            .tracking(0.8)
                    }
                    Spacer()
                    Text(topic.title)
                        .font(.system(size: 30, weight: .black, design: .rounded))
                        .tracking(-1)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(topic.description)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(4)
                    HStack(alignment: .top, spacing: 7) {
                        Text("WHY NOW")
                            .font(.caption2.weight(.black))
                            .tracking(0.8)
                        Text(topic.whyNow)
                            .font(.caption.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let url = URL(string: topic.url), url.scheme?.lowercased() == "https" {
                        Link(destination: url) {
                            HStack {
                                Text(topic.sourceLabel)
                                Spacer()
                                Image(systemName: "arrow.up.right")
                            }
                            .font(.caption.weight(.bold))
                            .padding(.top, 9)
                            .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.4)).frame(height: 1) }
                        }
                    }
                }
                .padding(20)
                .foregroundStyle(.white)
            }
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 15, y: 8)
        }
    }
}
