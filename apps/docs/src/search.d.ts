export const DOCS_HOME: "https://docs.ensemblework.com/";

export interface DocsIndex {
  version: 1;
  pages: {
    title: string;
    path: string;
    sections: { heading: string; url: string; text: string }[];
  }[];
}

export interface DocsAnswer {
  query: string;
  found: boolean;
  home: string;
  results: { title: string; heading: string; url: string; excerpt: string }[];
  message: string;
}

export function searchDocs(index: DocsIndex, query: string, limit?: number): DocsAnswer;
