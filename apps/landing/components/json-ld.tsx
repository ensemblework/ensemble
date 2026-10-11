// Structured data for search engines (schema.org JSON-LD). `<` is escaped so text
// in the data can never close the script tag.
export function JsonLd({ data }: { data: object | object[] }) {
  const graph = Array.isArray(data) ? { "@context": "https://schema.org", "@graph": data } : { "@context": "https://schema.org", ...data };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(graph).replace(/</g, "\\u003c") }} />;
}
