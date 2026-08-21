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
    "Explore the culture briefing, then build a personal weekly digest from the niche interests you actually follow.",
  applicationName: "what’s popular?",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "what’s popular?",
    title: "How trendy are you? — what’s popular?",
    description:
      "A finite culture briefing plus a pre-built weekly digest for the corners of the internet you actually care about.",
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
    description: "A finite culture briefing plus a pre-built weekly digest for the corners of the internet you actually care about.",
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
        {/* Stable fallback for browsers restoring HTML after a deployment. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/site.css" data-wp-stable-style="true" />
        <script dangerouslySetInnerHTML={{ __html: "try{const t=localStorage.getItem('whatspopular-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}" }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{const r=()=>{if([...document.styleSheets].some(s=>{try{return s.cssRules.length>0}catch{return false}})||document.documentElement.dataset.wpStyleRecovery)return;document.documentElement.dataset.wpStyleRecovery="pending";const l=document.createElement("link");l.rel="stylesheet";l.href="/site.css?recovery="+Date.now().toString(36);l.dataset.wpStyleRecovery="true";l.onload=()=>document.documentElement.dataset.wpStyleRecovery="ready";l.onerror=()=>document.documentElement.dataset.wpStyleRecovery="failed";document.head.appendChild(l)};const s=()=>setTimeout(r,0);document.readyState==="loading"?document.addEventListener("DOMContentLoaded",s,{once:true}):s();addEventListener("pageshow",s,{passive:true});setTimeout(r,500)})()`,
          }}
        />
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
