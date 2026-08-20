import SwiftUI
import UIKit

struct CultureImage: View {
    let path: String
    let contentMode: ContentMode
    let remoteImageVersion: String?

    @State private var image: UIImage?

    init(path: String, contentMode: ContentMode = .fill, remoteImageVersion: String? = nil) {
        self.path = path
        self.contentMode = contentMode
        self.remoteImageVersion = remoteImageVersion
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Rectangle()
                    .fill(Color.black.opacity(0.08))
                    .overlay {
                        Image(systemName: "sparkles")
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .task(id: "\(path)-\(remoteImageVersion ?? "bundled")") {
            await loadImage()
        }
    }

    private func loadImage() async {
        let filename = URL(fileURLWithPath: path).lastPathComponent
        let name = URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent
        let ext = URL(fileURLWithPath: filename).pathExtension
        let bundledImage = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "culture")
            .flatMap { UIImage(contentsOfFile: $0.path) }
        if let bundledImage {
            image = bundledImage
        }

        guard let remoteURL = MobileContentEndpoint.imageURL(for: path, revision: remoteImageVersion) else { return }

        do {
            var request = URLRequest(url: remoteURL)
            request.cachePolicy = .useProtocolCachePolicy
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard !Task.isCancelled,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let remoteImage = UIImage(data: data) else { return }
            image = remoteImage
        } catch {
            // The bundled or cached image remains visible when the network is unavailable.
        }
    }
}
