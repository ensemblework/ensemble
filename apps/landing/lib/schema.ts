import { site } from "@/lib/site";

export type Faq = { q: string; a: string };

const ORG_ID = `${site.url}/#organization`;
const WEBSITE_ID = `${site.url}/#website`;
const APP_ID = `${site.url}/#software`;

export const organization = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: site.name,
  alternateName: site.alternateNames,
  url: site.url,
  logo: { "@type": "ImageObject", url: `${site.url}/apple-icon.png`, width: 180, height: 180 },
  sameAs: [site.repoUrl, site.npmUrl],
};

// Google takes the site name shown in results from this, on the home page.
export const website = {
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: site.name,
  alternateName: [...site.alternateNames, "ensemblework.com"],
  url: site.url,
  description: site.description,
  inLanguage: "en",
  publisher: { "@id": ORG_ID },
};

export const softwareApplication = {
  "@type": "SoftwareApplication",
  "@id": APP_ID,
  name: site.name,
  alternateName: site.alternateNames,
  description: site.description,
  url: site.url,
  applicationCategory: "ProductivityApplication",
  applicationSubCategory: "AI notes app and AI agent workspace",
  operatingSystem: "Web, macOS, Windows, Linux",
  downloadUrl: `${site.url}/download`,
  installUrl: site.signupUrl,
  // Accounts are free; model features use the person's own provider key.
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: [
    "AI notes, meeting notes and task pages",
    "Plan your day: a Today page with calendar, reminders and proposed todos",
    "AI context management: people, projects, notes and skills in one place",
    "A shared board for you and your AI agents, with approvals",
    "Read-only MCP context for Claude Code, Cursor, VS Code, Codex and other editors",
    "Bring your own model: Gemini, OpenAI, Claude, OpenRouter, Ollama or GitHub Copilot",
  ],
  publisher: { "@id": ORG_ID },
};

export function faqPage(faqs: readonly Faq[], path: string) {
  return {
    "@type": "FAQPage",
    "@id": `${site.url}${path}#faq`,
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function webPage(path: string, title: string, description: string) {
  return {
    "@type": "WebPage",
    "@id": `${site.url}${path}#webpage`,
    url: path === "/" ? site.url : `${site.url}${path}`,
    name: title,
    description,
    inLanguage: "en",
    isPartOf: { "@id": WEBSITE_ID },
    about: { "@id": APP_ID },
  };
}

export function breadcrumb(path: string, name: string) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: site.name, item: site.url },
      { "@type": "ListItem", position: 2, name, item: `${site.url}${path}` },
    ],
  };
}
