import type { Metadata } from "next";
import { Icon } from "@/components/icon";
import { JsonLd } from "@/components/json-ld";
import { Mark } from "@/components/mark";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { pageMetadata } from "@/lib/metadata";
import { breadcrumb, faqPage, webPage } from "@/lib/schema";
import { site } from "@/lib/site";
import { TOPICS, type Topic } from "@/lib/topics";

export function topicMetadata(topic: Topic): Metadata {
  return pageMetadata({ path: `/${topic.slug}`, title: topic.title, description: topic.description });
}

export function TopicPage({ topic }: { topic: Topic }) {
  const path = `/${topic.slug}`;
  const others = TOPICS.filter((t) => t.slug !== topic.slug);
  return (
    <>
      <div className="grain" aria-hidden="true" />
      <SiteHeader />

      <main>
        <section className="download-hero topic-hero">
          <div className="glow" aria-hidden="true" />
          <nav className="crumbs" aria-label="Breadcrumb">
            <a href="/">Ensemble</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{topic.label}</span>
          </nav>
          <p className="eyebrow">{topic.eyebrow}</p>
          <h1>
            {topic.heading} <em>{topic.headingEm}</em>
          </h1>
          <p className="lede">{topic.lede}</p>
          <div className="ctas center">
            <a className="btn" href={site.signupUrl}>
              Get started free <span aria-hidden="true">→</span>
            </a>
            <a className="btn btn-ghost" href="/download">
              Download
            </a>
          </div>
        </section>

        <section className="section topic-section" aria-label="Features">
          <div className="topic-points">
            {topic.points.map((point) => (
              <article key={point.title} className="feature topic-point">
                <Icon name={point.icon} />
                <h2>{point.title}</h2>
                <p>{point.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="section download-section faq-section">
          <div className="section-head">
            <p className="eyebrow">FAQ</p>
            <h2>
              Questions, <em>answered.</em>
            </h2>
          </div>
          <div className="faq-grid">
            {topic.faq.map((f) => (
              <article key={f.q}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section download-section">
          <div className="section-head">
            <p className="eyebrow">Keep reading</p>
            <h2>
              More of <em>the workspace.</em>
            </h2>
          </div>
          <div className="topic-links">
            {others.map((t) => (
              <a key={t.slug} className="feature topic-link" href={`/${t.slug}`}>
                <Icon name={t.icon} />
                <h3>{t.label}</h3>
                <p>{t.summary}</p>
                <span className="topic-more">
                  Read more <span aria-hidden="true">→</span>
                </span>
              </a>
            ))}
          </div>
        </section>

        <section className="section final">
          <Mark size={44} />
          <h2>
            Bring your agent <em>into the room.</em>
          </h2>
          <p className="section-lede">
            Create a free account, save your notes and context, and bring your own model key when you are ready to use an agent.
          </p>
          <div className="ctas center">
            <a className="btn" href={site.signupUrl}>
              Get started <span aria-hidden="true">→</span>
            </a>
            <a className="btn btn-ghost" href="/">
              See the whole product
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
      <JsonLd data={[webPage(path, topic.title, topic.description), breadcrumb(path, topic.label), faqPage(topic.faq, path)]} />
    </>
  );
}
