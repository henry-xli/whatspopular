import type { Metadata, Viewport } from "next";
import { SiteHeader } from "./components/site-header";
import { SiteFooter } from "./components/site-footer";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://whatspopular.com"),
  title: {
    default: "How trendy are you? — what’s popular?",
    template: "%s — what’s popular?",
  },
  description:
    "Quiz yourself on the memes, slang, people, movies, books, music, products, and news shaping internet culture.",
  applicationName: "what’s popular?",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "what’s popular?",
    title: "How trendy are you? — what’s popular?",
    description:
      "A finite 48-hour briefing and quiz on what the internet is talking about.",
    url: "/",
    images: [
      {
        url: "/og.jpg",
        width: 1200,
        height: 630,
        alt: "what’s popular? — How trendy are you?",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "How trendy are you? — what’s popular?",
    description: "A finite 48-hour briefing and quiz on what the internet is talking about.",
    images: ["/og.jpg"],
  },
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f0e7" },
    { media: "(prefers-color-scheme: dark)", color: "#131217" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try{const t=localStorage.getItem('whatspopular-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}" }} />
      </head>
      <body>
        <a className="skip-link" href="#main-content">Skip to the briefing</a>
        <SiteHeader />
        {children}
        <SiteFooter />
        <script
          data-name="BMC-Widget"
          data-cfasync="false"
          src="https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js"
          data-id="0WTynrfuTb"
          data-description="Support me on Buy me a coffee!"
          data-message=""
          data-color="#BD5FFF"
          data-position="Right"
          data-x_margin="18"
          data-y_margin="18"
          defer
        />
      </body>
    </html>
  );
}
