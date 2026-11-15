import type { Metadata, Viewport } from "next";
import { icons } from "@ensemble/brand/icons";
import { Figtree, Fraunces, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import { JsonLd } from "@/components/json-ld";
import { organization, website } from "@/lib/schema";
import { site } from "@/lib/site";
import "@ensemble/brand/motion.css";
import "./globals.css";

const sans = Figtree({ subsets: ["latin"], display: "swap", variable: "--font-sans" });
const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display",
});
// No size-adjusted fallback: it is a local Arial face, and it would draw any glyph JetBrains Mono lacks (box
// drawing, terminal symbols) at Arial's width, ahead of every face that follows in --font-code.
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", adjustFontFallback: false, variable: "--font-mono" });
// Google serves JetBrains Mono without box drawing or terminal symbols. This file holds them, cut from
// JetBrains Mono 2.304 Regular (OFL, beside it); --font-code lists it right after the Google faces, and its
// unicode-range means only pages that show one of these characters fetch it. A new glyph has to be cut into
// the file and listed here. Declared for every weight so no browser fakes a bold, which widens glyphs in Safari.
const monoSymbols = localFont({
  src: "./fonts/jetbrains-mono-symbols.woff2",
  weight: "100 800",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value: "U+2190, U+2192, U+23CE, U+2500-25A0, U+25B8, U+25C6-25C7, U+25CB-25CC, U+25CF, U+2713, U+2717, U+276F",
    },
  ],
  variable: "--font-mono-symbols",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: "%s | Ensemble" },
  description: site.description,
  applicationName: site.name,
  icons,
  keywords: [...site.keywords],
  category: "productivity",
  creator: site.name,
  publisher: site.name,
  // Let search engines show large image previews and full-length snippets.
  robots: { googleBot: { "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
  openGraph: {
    type: "website",
    siteName: site.name,
    locale: "en_US",
    title: site.title,
    description: site.description,
  },
  twitter: { card: "summary_large_image", title: site.title, description: site.description },
};

export const viewport: Viewport = {
  themeColor: "#10282b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable} ${monoSymbols.variable}`}>
      <body>
        {children}
        <JsonLd data={[organization, website]} />
      </body>
    </html>
  );
}
