import type { Metadata, Viewport } from "next";
import { Figtree, Fraunces, JetBrains_Mono } from "next/font/google";
import { APPEARANCE_BOOT } from "@/lib/accent";
import { PAGE_BOOT } from "@/lib/page-width";
import { publicSiteUrl } from "@/lib/site-url";
import "./globals.css";
import "@/components/motion/suite.css";
import "@/components/motion/springs.css";
import "@/components/motion/search-query.css";
import "@/components/motion/terminal-working.css";
import "@/components/motion/morph.css";
import "@/components/motion/board-drag/board-drag.css";
import "@/components/motion/board-drag/board-drag.app.css";
import { Providers } from "./providers";

const sans = Figtree({
  subsets: ["latin"],
  display: "swap",
  preload: true,
  adjustFontFallback: true,
  variable: "--font-sans",
});
// Titles are few. Figtree is the critical face; Fraunces swaps in on top of a
// size-adjusted fallback so it is not on the first-request critical path.
const display = Fraunces({
  subsets: ["latin"],
  // 500 is the display face. 400 is the desk numeral face (opsz 144).
  weight: ["400", "500"],
  display: "swap",
  preload: false,
  adjustFontFallback: true,
  variable: "--font-display-face",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  // swap, not optional: optional drops the face for the whole page when it misses
  // the first paint, which is what left editors in the proportional UI font.
  display: "swap",
  preload: true,
  // A size-adjusted fallback is a real local face (often sans) and wins over the
  // monospace stack that follows the CSS variable.
  adjustFontFallback: false,
  variable: "--font-mono-face",
});

const site = publicSiteUrl();

export const metadata: Metadata = {
  ...(site ? { metadataBase: site } : {}),
  title: { default: "Ensemble", template: "%s · Ensemble" },
  description: "A shared workspace for you and your agent.",
  applicationName: "Ensemble",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "Ensemble",
    title: "Ensemble",
    description: "A shared workspace for you and your agent.",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Ensemble: a shared workspace for you and your agent." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ensemble",
    description: "A shared workspace for you and your agent.",
    images: [{ url: "/twitter-image.png", width: 1200, height: 600, alt: "Ensemble: a shared workspace for you and your agent." }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#141210" },
    { media: "(prefers-color-scheme: light)", color: "#faf7f2" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT }} />
        <script dangerouslySetInnerHTML={{ __html: PAGE_BOOT }} />
      </head>
      <body className="min-h-screen font-sans text-[14px] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
