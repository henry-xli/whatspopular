import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { SiteHeader } from "./components/site-header";
import { SiteFooter } from "./components/site-footer";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://whatspopular.com"),
  title: {
    default: "what’s popular? — Internet culture, caught up",
    template: "%s — what’s popular?",
  },
  description:
    "A five-minute daily briefing on the memes, slang, creators, movies, shows, and songs shaping internet culture.",
  applicationName: "what’s popular?",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "what’s popular?",
    title: "what’s popular? — Internet culture, caught up",
    description:
      "The finite daily briefing on memes, slang, creators, movies, shows, and songs.",
    url: "/",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "what’s popular? — internet culture, minus the infinite scroll.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "what’s popular? — Internet culture, caught up",
    description: "The finite daily briefing on what the internet is talking about.",
    images: ["/og.png"],
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
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>
        <a className="skip-link" href="#main-content">Skip to the briefing</a>
        <SiteHeader />
        <div id="main-content">{children}</div>
        <SiteFooter />
        <Script
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
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}
