import type { Metadata, Viewport } from "next";
import { Figtree, Fraunces, JetBrains_Mono } from "next/font/google";
import { JsonLd } from "@/components/json-ld";
import { organization, website } from "@/lib/schema";
import { site } from "@/lib/site";
import "./globals.css";

const sans = Figtree({ subsets: ["latin"], display: "swap", variable: "--font-sans" });
const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display",
});
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: "%s | Ensemble" },
  description: site.description,
  applicationName: site.name,
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
  themeColor: "#141210",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body>
        {children}
        <JsonLd data={[organization, website]} />
      </body>
    </html>
  );
}
