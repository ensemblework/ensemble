"use client";
import { BrandMorph } from "@/components/motion/brand-morph";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, FileUp, KeyRound, Plug, RefreshCw, Wrench } from "lucide-react";
import { useId, useState } from "react";
import {
  CONNECTOR_CATEGORIES,
  connectorGuide,
  guideParts,
  hasWrittenGuide,
  IMPORT_TIPS,
  type ConnectorGuide,
  type ConnectorProduct,
  type Settings,
} from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { CONNECTOR_QUERY, connectorsApi, needsReconnect, type CatalogEntry, type McpConnection } from "@/lib/api-connectors";
import { relative, type Tone } from "@/lib/format";
import { AppSetup, SignInWithGoogle } from "@/components/settings/setup";
import { useToast } from "../toast";
import { Spinner, Tag, Toggle, cx } from "../ui";
import { BrandLogo } from "./brand-logo";
import { browser } from "./browser";
import { connectorUses, entryStatus, oauthReady, PEOPLE_SYNC_SOURCES, statusLabel, usableAuth, type EntryStatus } from "./catalog-view";
import { McpTokenPrompt, useMcpConnect } from "./mcp-connect";
import { McpConnectWay } from "./mcp-way";
import { tokenFields, tokenFormReady, tokenHelp, type TokenField } from "./token-forms";
import { useRefreshConnections, useSetEntryState } from "./use-connectors";

type Patch = (value: Record<string, unknown>) => void;

export { browser };

const STATUS_TONE: Record<EntryStatus, Tone> = {
  connected: "green",
  attention: "red",
  pending: "blue",
  available: "gray",
  not_set_up: "orange",
  soon: "gray",
};

const DOT: Record<EntryStatus, string> = {
  connected: "bg-ok",
  attention: "bg-danger",
  pending: "bg-accent",
  available: "bg-faint",
  not_set_up: "bg-warn",
  soon: "bg-faint",
};

/** A tag, or a dot and plain text that wraps on narrow screens. */
export function StatusBadge({ entry, plain = false }: { entry: CatalogEntry; plain?: boolean }) {
  const status = entryStatus(entry);
  if (plain) {
    return (
      <span className="inline-flex min-w-0 items-baseline gap-1.5">
        <span aria-hidden className={cx("inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full", DOT[status])} />
        <span className={status === "connected" ? "text-ink/90" : undefined}>{statusLabel(entry)}</span>
      </span>
    );
  }
  return <Tag tone={STATUS_TONE[status]}>{statusLabel(entry)}</Tag>;
}

const SOURCE_NAMES: Record<string, string> = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  outlook: "Outlook mail",
  outlook_calendar: "Outlook calendar",
  teams: "Teams",
  notion: "Notion",
};

/** The short name people use: "Notion", not "Notion Labs"; "Atlassian" for Jira; "Hugging Face" whole. */
export function brand(entry: Pick<CatalogEntry, "name" | "vendor">): string {
  if (entry.vendor === entry.name) return entry.name;
  const first = entry.name.split(" ")[0];
  return entry.vendor.split(" ")[0] === first && first ? first : entry.vendor;
}

function sourceName(entry: CatalogEntry, id: string): string {
  return entry.products?.find((product) => product.sources?.includes(id))?.name ?? SOURCE_NAMES[id] ?? entry.name;
}

export function ConnectorDetail({
  entry,
  mcp,
  settings,
  patch,
  onImport,
  headingRef,
}: {
  entry: CatalogEntry;
  /** This entry's remote MCP connection, when there is one. */
  mcp?: McpConnection;
  settings?: Settings;
  patch?: Patch;
  onImport: (source: string) => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const category = CONNECTOR_CATEGORIES.find((row) => row.id === entry.category)?.label;
  const notes = [...(entry.notes ?? []), ...(entry.mcp?.note ? [entry.mcp.note] : [])];
  const mcpKnown = Boolean(mcp || entry.state.mcp);
  const docs = entry.docsUrl ?? entry.mcp?.docs;
  const uses = connectorUses(entry);
  return (
    <div className="grid gap-6 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_240px]" data-testid="connector-detail" data-connector={entry.id}>
      <div className="min-w-0 space-y-4">
        <header className="flex items-start gap-3">
          <BrandLogo id={entry.logo} name={entry.name} size={44} decorative />
          <div className="min-w-0">
            <h3 ref={headingRef} tabIndex={-1} className="text-[18px] font-semibold leading-6 outline-none">
              {entry.name}
            </h3>
            <div className="text-[12.5px] text-muted">
              {entry.vendor}
              {category ? ` · ${category}` : ""}
            </div>
            <div className="mt-1.5">
              <StatusBadge entry={entry} />
            </div>
          </div>
        </header>
        <p className="text-[13.5px] leading-5 text-ink/90">{entry.tagline}</p>
        {entry.status === "soon" ? (
          <section className="rounded-xl border border-dashed border-line-strong px-3 py-3 text-[13px] text-muted">
            <div className="font-medium text-ink">Coming soon</div>
            Listed so you know it is planned. It cannot be connected yet.
          </section>
        ) : (
          <>
            {entry.state.connected ? (
              <ConnectedPanel entry={entry} settings={settings} patch={patch} />
            ) : (
              <ConnectPanel entry={entry} mcpKnown={mcpKnown} onImport={onImport} />
            )}
            {entry.auth.includes("mcp") && (mcpKnown || entry.state.connected) ? <McpPanel entry={entry} connection={mcp} /> : null}
            {entry.import ? <ImportPanel entry={entry} onImport={onImport} /> : null}
          </>
        )}
      </div>
      <aside className="space-y-4 text-[12.5px] lg:border-l lg:border-line lg:pl-5">
        {uses.length ? <Facts title="In Ensemble" items={uses} /> : null}
        <Facts title="What it reads" items={entry.reads} empty="Nothing is read until you import." />
        <Facts title="What it can change" items={entry.writes} empty="Nothing. It only reads." note={entry.writes.length ? "Each change waits for your Apply." : undefined} />
        {notes.length ? <Facts title="Good to know" items={notes} /> : null}
        {docs ? (
          <a href={docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            {entry.vendor} documentation <ExternalLink size={11} />
          </a>
        ) : null}
      </aside>
    </div>
  );
}

function Facts({ title, items, empty, note }: { title: string; items: readonly string[]; empty?: string; note?: string }) {
  return (
    <div>
      <h4 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h4>
      {items.length ? (
        <ul className="mt-1 space-y-0.5 text-ink/90">
          {items.map((item) => (
            <li key={item} className="flex gap-1.5">
              <span aria-hidden className="text-faint">
                ·
              </span>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted">{empty}</p>
      )}
      {note ? <p className="mt-1 text-muted">{note}</p> : null}
    </div>
  );
}

// ── not connected ─────────────────────────────────────────────────────────

function ConnectPanel({ entry, mcpKnown, onImport }: { entry: CatalogEntry; mcpKnown: boolean; onImport: (source: string) => void }) {
  const toast = useToast();
  const refresh = useRefreshConnections();
  const products = entry.products ?? [];
  const [chosen, setChosen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(products.map((product) => [product.id, entry.state.products?.[product.id] ?? product.defaultOn])),
  );
  const [tokenOpen, setTokenOpen] = useState(false);
  const oauthBlocked = entry.auth.includes("oauth") && !oauthReady(entry);
  const ways = usableAuth(entry).filter((kind): kind is "oauth" | "token" | "mcp" | "file" => {
    if (kind === "builtin") return false;
    if (kind === "file") return !entry.import;
    if (kind === "mcp") return !mcpKnown;
    return true;
  });
  const picked = products.filter((product) => chosen[product.id]).map((product) => product.id);
  // One guide per panel: the written one (pasted credential, MCP token or address), else what sign-in does on the first way.
  const mcpWaiting = Boolean(entry.mcp?.client && entry.state.mcpReady === false);
  const guided = ways.filter((kind): kind is "oauth" | "token" | "mcp" => kind !== "file" && !(kind === "mcp" && mcpWaiting));
  const guideWay = guided.find((kind) => hasWrittenGuide(entry, kind)) ?? guided.find((kind) => kind !== "token");
  const guideFor = (kind: "oauth" | "token" | "mcp") => {
    const guide = kind === guideWay ? connectorGuide(entry, kind) : undefined;
    return guide ? <ConnectGuide guide={guide} defaultOpen /> : null;
  };
  const start = useMutation({
    mutationFn: () =>
      connectorsApi.start(entry.provider ?? entry.id, { products: products.length ? picked : undefined, returnTo: browser.returnTo(entry.id) }),
    onSuccess: (result) => browser.assign(result.url),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  if (entry.auth.includes("builtin")) {
    return <p className="rounded-xl border border-line px-3 py-2.5 text-[13px] text-muted">Built in and always on.</p>;
  }
  if (!ways.length) {
    return oauthBlocked ? <NotSetUp entry={entry} /> : null;
  }
  return (
    <section className="rounded-xl border border-line" aria-label={`Connect ${entry.name}`}>
      {products.length && ways.includes("oauth") ? (
        <div className="border-b border-line px-3 py-3 sm:px-4">
          <h4 className="text-[13px] font-semibold">Choose what Ensemble may use</h4>
          <p className="text-[12px] text-muted">{brand(entry)} asks only for what you switch on. You can change this later.</p>
          <ProductList products={products} value={chosen} onChange={(id, on) => setChosen((current) => ({ ...current, [id]: on }))} />
        </div>
      ) : null}
      <ul className="divide-y divide-[var(--line)]">
        {ways.map((kind, index) => {
          const primary = index === 0 ? "btn-primary" : "btn";
          if (kind === "oauth") {
            return (
              <Way key={kind} title={`Sign in with ${brand(entry)}`} detail={`Approve access on ${brand(entry)}'s page. You come straight back here.`} guide={guideFor(kind)}>
                {entry.provider === "google" ? (
                  <SignInWithGoogle pending={start.isPending} onClick={() => (picked.length || !products.length ? start.mutate() : undefined)} />
                ) : (
                  <button type="button" className={primary} disabled={start.isPending || (products.length > 0 && !picked.length)} onClick={() => start.mutate()}>
                    {start.isPending ? <Spinner size={12} /> : <Plug size={12} />} Connect
                  </button>
                )}
                {products.length && !picked.length ? <span className="text-[12px] text-warn">Switch on at least one.</span> : null}
              </Way>
            );
          }
          if (kind === "token") {
            const term = connectorGuide(entry, "token")?.term;
            const several = Boolean(term?.includes(" and "));
            return (
              <Way
                key={kind}
                title={term ? `Paste your ${term}` : tokenFields(entry.provider).length > 1 ? "Use an API token" : "Paste a token"}
                detail={
                  term
                    ? `Create ${several ? "them" : `${article(term)} ${term}`} in ${brand(entry)}, then paste ${several ? "them" : "it"} here. ${several ? "They are" : "It is"} checked with ${brand(entry)} and stored encrypted.`
                    : (tokenHelp(entry).hint ?? `Create a token in ${entry.name}, then paste it here. It is stored encrypted.`)
                }
                guide={guideFor(kind)}
                below={tokenOpen ? <TokenForm entry={entry} onDone={() => setTokenOpen(false)} /> : null}
              >
                {tokenOpen ? null : (
                  <button type="button" className={primary} aria-expanded={tokenOpen} onClick={() => setTokenOpen(true)}>
                    <KeyRound size={12} /> {term ? (several ? "Paste them" : "Paste it") : "Paste a token"}
                    {term ? <span className="sr-only">: your {term}</span> : null}
                  </button>
                )}
              </Way>
            );
          }
          if (kind === "mcp") {
            return (
              <Way
                key={kind}
                title={`Use ${entry.name}'s own tools`}
                detail={mcpDetail(entry)}
                guide={guideFor(kind)}
                below={<McpConnectWay entry={entry} primary={index === 0} />}
              >
                {null}
              </Way>
            );
          }
          return (
            <Way key={kind} title="Import a file" detail="Upload an export. Nothing stays connected.">
              <button type="button" className={primary} onClick={() => onImport(entry.id)}>
                <FileUp size={12} /> Import
              </button>
            </Way>
          );
        })}
      </ul>
      {oauthBlocked ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-[12px] text-faint sm:px-4">
          <span>Sign in with {brand(entry)} is not available yet. Use one of the connection options above.</span>
          <OperatorSetup provider={entry.provider} />
        </div>
      ) : null}
    </section>
  );
}

/** One line on how this vendor's MCP server signs in. */
function mcpDetail(entry: CatalogEntry): string {
  const mcp = entry.mcp!;
  const who = brand(entry);
  if (mcp.ownClient) return `Connects ${who}'s MCP server with an app your ${who} admin registers. Changes wait for your Apply.`;
  if (mcp.connection) return `Gives the assistant ${who}'s own tools through ${who}'s MCP server, signed in with your ${who} connection. Changes wait for your Apply.`;
  if (mcp.token?.only) return `Connects ${who}'s MCP server with a token you create in ${who}. Choose which tools the assistant may use; changes wait for your Apply.`;
  if (mcp.fields?.length) return `Connects ${who}'s MCP server for your account. You approve on ${who}'s site, then choose which tools the assistant may use.`;
  if (mcp.open) return `Connects ${who}'s public MCP server. No account or sign-in; choose which tools the assistant may use.`;
  if (mcp.token) return `Connects ${who}'s MCP server with your ${who} account: sign in on ${who}'s site, or paste a token. Then choose which tools the assistant may use.`;
  return `Connects ${who}'s MCP server. You approve on ${who}'s site, then choose which tools the assistant may use. Changes wait for your Apply.`;
}

function Way({ title, detail, children, guide, below }: { title: string; detail: string; children: React.ReactNode; guide?: React.ReactNode; below?: React.ReactNode }) {
  return (
    <li className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="text-[13.5px] font-medium">{title}</div>
          <div className="text-[12.5px] leading-[18px] text-muted">{detail}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      </div>
      {guide}
      {below}
    </li>
  );
}

function article(term: string): string {
  return /^[aeiou]/i.test(term) ? "an" : "a";
}

/** Text with its https addresses as links that open in a new tab. */
function GuideText({ text }: { text: string }) {
  return (
    <>
      {guideParts(text).map((part, index) =>
        part.href ? (
          <a key={index} href={part.href} target="_blank" rel="noreferrer" className="break-all text-accent underline-offset-2 hover:underline">
            {part.text}
            <ExternalLink size={10} aria-hidden className="ml-0.5 inline align-[-1px]" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

const CALLOUT_EDGE = { ok: "border-ok/60", warn: "border-warn/70", plain: "border-line-strong" } as const;

function Callout({ label, tone, text }: { label: string; tone: keyof typeof CALLOUT_EDGE; text: string }) {
  return (
    <div className={cx("flex flex-wrap gap-x-3 gap-y-0.5 border-l-2 py-0.5 pl-2.5", CALLOUT_EDGE[tone])}>
      <dt className="w-[86px] shrink-0 pt-px text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 basis-[200px] text-ink/85">
        <GuideText text={text} />
      </dd>
    </div>
  );
}

/** The numbered "how to connect" steps for one way of connecting, in a disclosure. */
function ConnectGuide({ guide, defaultOpen = false }: { guide: ConnectorGuide; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const callouts = [
    guide.looksLike ? { label: "Looks like", tone: "ok" as const, text: guide.looksLike } : null,
    guide.notThis ? { label: "Not this", tone: "warn" as const, text: guide.notThis } : null,
    guide.scopes ? { label: "Permissions", tone: "plain" as const, text: guide.scopes } : null,
    guide.whereToFind ? { label: "More help", tone: "plain" as const, text: guide.whereToFind } : null,
  ].filter((row) => row !== null);
  return (
    <div className="mt-2.5 rounded-lg border border-line" data-testid="connect-guide">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-hover"
      >
        <ChevronRight size={13} aria-hidden className={cx("shrink-0 text-muted transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span className="shrink-0 font-medium">Step-by-step guide</span>
        {guide.title ? <span className="hidden min-w-0 truncate text-muted sm:inline">· {guide.title}</span> : null}
        <span className="ml-auto shrink-0 pl-2 text-[11.5px] tabular-nums text-faint">{guide.steps.length} steps</span>
      </button>
      {open ? (
        <div id={id} className="border-t border-line px-3 pb-3 pt-2.5">
          <ol className="space-y-2" aria-label={guide.title ?? "Steps"}>
            {guide.steps.map((step, index) => (
              <li key={step} className="flex gap-2.5 text-[12.5px] leading-[18px]">
                <span aria-hidden className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-line-strong text-[10.5px] font-semibold tabular-nums text-muted">
                  {index + 1}
                </span>
                <span className="min-w-0 pt-px">
                  <GuideText text={step} />
                </span>
              </li>
            ))}
          </ol>
          {callouts.length ? (
            <dl className="mt-3 space-y-1.5 text-[12px] leading-[17px]">
              {callouts.map((row) => (
                <Callout key={row.label} label={row.label} tone={row.tone} text={row.text} />
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Set up once" for whoever runs this server; nothing for everyone else. */
function OperatorSetup({ provider }: { provider?: string }) {
  const apps = useQuery({ queryKey: ["connector-apps"], queryFn: api.connectorApps, enabled: Boolean(provider), retry: false });
  const app = apps.data?.apps.find((row) => (row.provider as string) === provider);
  if (!app || !apps.data?.canEdit) return null;
  return <AppSetup app={app} canEdit />;
}

function NotSetUp({ entry }: { entry: CatalogEntry }) {
  return (
    <section role="note" className="rounded-xl border border-line bg-raised px-3 py-3 text-[13px] sm:px-4" data-testid="not-set-up">
      <div className="font-medium">Not available to connect yet</div>
      <p className="mt-0.5 text-[12.5px] text-muted">
        Connecting {entry.name} needs a {brand(entry)} app registered for this Ensemble server. Whoever runs it registers the app once and adds its
        client ID and secret; after that everyone just signs in here.
      </p>
      <div className="mt-2 empty:hidden">
        <OperatorSetup provider={entry.provider} />
      </div>
    </section>
  );
}

function TokenForm({ entry, onDone }: { entry: CatalogEntry; onDone: () => void }) {
  const toast = useToast();
  const refresh = useRefreshConnections();
  const fields = tokenFields(entry.provider);
  const help = tokenHelp(entry);
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => connectorsApi.connectToken(entry.provider ?? entry.id, Object.fromEntries(fields.map((field) => [field.name, (values[field.name] ?? "").trim()]))),
    onSuccess: (result) => {
      toast(`Connected as ${result.account}.`, { tone: "ok" });
      setValues({});
      onDone();
      refresh();
    },
  });
  const ready = tokenFormReady(fields, values);
  const errorId = useId();
  return (
    <form
      className="mt-3 space-y-2 rounded-lg bg-raised p-3"
      data-testid="token-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !save.isPending) save.mutate();
      }}
    >
      {help.url ? (
        <a href={help.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
          Where to get it <ExternalLink size={11} />
        </a>
      ) : null}
      {fields.map((field, index) => (
        <div key={field.name}>
          <label className="block text-[12.5px] font-medium">
            {field.label}
            <input
              autoFocus={index === 0}
              name={field.name}
              type={field.secret ? "password" : (field.type ?? "text")}
              autoComplete="off"
              spellCheck={false}
              value={values[field.name] ?? ""}
              placeholder={field.placeholder}
              aria-invalid={save.isError || undefined}
              aria-describedby={save.isError ? errorId : undefined}
              onChange={(event) => {
                if (save.isError) save.reset();
                setValues((current) => ({ ...current, [field.name]: event.target.value }));
              }}
              className={cx("field mt-1 w-full", field.secret && "font-mono")}
            />
          </label>
          {field.link ? <FieldLink link={field.link} values={values} /> : null}
        </div>
      ))}
      {save.isError ? (
        <p id={errorId} role="alert" className="text-[12.5px] text-danger" data-testid="token-error">
          {(save.error as Error).message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <span className="mr-auto text-[12px] text-muted">Checked with {brand(entry)}, then stored encrypted.</span>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!ready || save.isPending}>
          {save.isPending ? <Spinner size={12} /> : null} Check and connect
        </button>
      </div>
    </form>
  );
}

/** A vendor page built from the fields, e.g. Trello's token page for the key typed above. */
function FieldLink({ link, values }: { link: NonNullable<TokenField["link"]>; values: Record<string, string> }) {
  const href = link.href(values);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="btn py-0.5 text-[12px]">
          {link.label} <ExternalLink size={11} aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <>
          <button type="button" className="btn py-0.5 text-[12px]" disabled>
            {link.label}
          </button>
          <span>{link.hint}</span>
        </>
      )}
    </div>
  );
}

function ProductList({
  products,
  value,
  onChange,
  pending,
}: {
  products: readonly ConnectorProduct[];
  value: Record<string, boolean>;
  onChange: (id: string, on: boolean) => void;
  pending?: string | null;
}) {
  return (
    <ul className="mt-2 divide-y divide-[var(--line)]" aria-label="Products">
      {products.map((product) => (
        <li key={product.id} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
              {product.name}
              {product.write ? <Tag tone="blue">can change, asks first</Tag> : null}
            </div>
            <div className="text-[12px] text-muted">{product.access}</div>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            {pending === product.id ? <Spinner size={12} /> : null}
            <Toggle label={product.name} checked={Boolean(value[product.id])} onChange={(on) => onChange(product.id, on)} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── connected ────────────────────────────────────────────────────────────

function ConnectedPanel({ entry, settings, patch }: { entry: CatalogEntry; settings?: Settings; patch?: Patch }) {
  const toast = useToast();
  const refresh = useRefreshConnections();
  const setState = useSetEntryState();
  const [confirming, setConfirming] = useState(false);
  const [reconnect, setReconnect] = useState<{ url: string; product: string } | null>(null);
  const products = entry.products ?? [];
  const values = Object.fromEntries(products.map((product) => [product.id, entry.state.products?.[product.id] ?? false]));
  const setProducts = useMutation({
    mutationFn: (change: { id: string; on: boolean }) => connectorsApi.setProducts(entry.id, { ...values, [change.id]: change.on }, browser.returnTo(entry.id)),
    onMutate: (change) => {
      setReconnect(null);
      setState(entry.id, (state) => ({ ...state, products: { ...state.products, [change.id]: change.on } }));
    },
    onSuccess: (result, change) => {
      if (needsReconnect(result)) {
        if (result.state) setState(entry.id, () => result.state!);
        else setState(entry.id, (state) => ({ ...state, products: { ...state.products, [change.id]: values[change.id] ?? false } }));
        setReconnect({ url: result.url, product: products.find((product) => product.id === change.id)?.name ?? change.id });
        return;
      }
      setState(entry.id, () => result);
    },
    onError: (error, change) => {
      setState(entry.id, (state) => ({ ...state, products: { ...state.products, [change.id]: values[change.id] ?? false } }));
      toast((error as Error).message, { tone: "error" });
    },
  });
  const sync = useMutation({
    mutationFn: (id: string) => connectorsApi.syncSource(id),
    onSuccess: (result) => {
      toast(result.message, { tone: result.ok ? "ok" : "error" });
      refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const approve = useMutation({
    mutationFn: () =>
      connectorsApi.start(entry.provider ?? entry.id, {
        products: products.filter((product) => values[product.id] || entry.state.needsConsent?.includes(product.id)).map((product) => product.id),
        returnTo: browser.returnTo(entry.id),
      }),
    onSuccess: (result) => browser.assign(result.url),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const waiting = products.filter((product) => entry.state.needsConsent?.includes(product.id));
  const sources = Object.entries(entry.state.sources ?? {}).filter(([id]) => PEOPLE_SYNC_SOURCES.has(id));
  return (
    <section className="rounded-xl border border-line" aria-label={`${entry.name} connection`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{entry.state.account ? `Connected as ${entry.state.account}` : "Connected"}</div>
          <div className="text-[12.5px] text-muted">Switching something off stops new reads right away. What was already read stays until you delete it.</div>
        </div>
        {confirming ? null : (
          <button type="button" className="btn-ghost text-[12.5px]" onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        )}
      </div>
      {confirming ? <DisconnectConfirm entry={entry} onCancel={() => setConfirming(false)} /> : null}
      {products.length ? (
        <div className="border-t border-line px-3 pb-1 pt-3 sm:px-4">
          <h4 className="text-[13px] font-semibold">Products</h4>
          <ProductList
            products={products}
            value={values}
            pending={setProducts.isPending ? setProducts.variables?.id : null}
            onChange={(id, on) => setProducts.mutate({ id, on })}
          />
          {waiting.length && !reconnect ? (
            <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn/50 bg-raised px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1">
                {waiting.map((product) => product.name).join(", ")} {waiting.length === 1 ? "is" : "are"} on, but {brand(entry)} has not approved access yet.
              </span>
              <button type="button" className="btn-primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
                Approve access
              </button>
            </div>
          ) : null}
          {reconnect ? (
            <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1">
                {brand(entry)} needs your OK for {reconnect.product}. You come straight back here.
              </span>
              <button type="button" className="btn-primary" onClick={() => browser.assign(reconnect.url)}>
                Continue to {brand(entry)}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setReconnect(null)}>
                Not now
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {sources.length ? (
        <div className="border-t border-line px-3 py-2 sm:px-4">
          <h4 className="pt-1 text-[13px] font-semibold">Contact sync</h4>
          <p className="mt-1 text-[12px] text-muted">Sync saves people only. Files and messages are saved when you ask.</p>
          <ul className="divide-y divide-[var(--line)]">
            {sources.map(([id, source]) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="text-[13px]">{sourceName(entry, id)}</div>
                  <div className="text-[12px] text-faint">
                    {!source.enabled ? "Off" : source.lastSyncAt ? `Synced ${relative(source.lastSyncAt)}` : "Not synced yet"}
                  </div>
                  {source.lastError && source.enabled ? <div className="text-[12px] text-danger">{source.lastError}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn py-0.5 text-[12px]"
                    disabled={!source.enabled || (sync.isPending && sync.variables === id)}
                    onClick={() => sync.mutate(id)}
                    aria-label={`Sync ${sourceName(entry, id)} now`}
                  >
                    {sync.isPending && sync.variables === id ? <BrandMorph size={14} kind="beacon" state="loop" /> : <RefreshCw size={11} />} Sync people
                  </button>
                  {!products.length && patch ? (
                    <Toggle
                      label={`Read ${sourceName(entry, id)}`}
                      checked={source.enabled}
                      onChange={(enabled) => {
                        patch({ connections: { [id]: { enabled } } });
                        setState(entry.id, (state) => ({ ...state, sources: { ...state.sources, [id]: { ...source, enabled } } }));
                      }}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {entry.provider === "slack" && patch ? (
        <label className="block border-t border-line px-3 py-3 text-[13px] font-medium sm:px-4">
          Channels to read besides DMs
          <input
            defaultValue={settings?.connections?.slack?.scope ?? ""}
            onBlur={(event) => patch({ connections: { slack: { scope: event.target.value } } })}
            placeholder="#eng, #oncall"
            className="field mt-1 w-full max-w-sm text-[12.5px] font-normal"
          />
        </label>
      ) : null}
    </section>
  );
}

function DisconnectConfirm({ entry, onCancel }: { entry: CatalogEntry; onCancel: () => void }) {
  const toast = useToast();
  const refresh = useRefreshConnections();
  const [deleteData, setDeleteData] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => connectorsApi.disconnect(entry.provider ?? entry.id, deleteData),
    onSuccess: () => {
      toast(deleteData ? `${entry.name} disconnected. What Ensemble read from it is deleted.` : `${entry.name} disconnected.`);
      onCancel();
      refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <div role="group" aria-label={`Disconnect ${entry.name}`} className="mx-3 mb-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5 text-[13px] sm:mx-4" data-testid="disconnect-confirm">
      <div className="font-medium">Disconnect {entry.name}?</div>
      <p className="text-[12.5px] text-muted">Ensemble stops reading it and signs out of {brand(entry)} where it can.</p>
      <label className="mt-2 flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={deleteData} onChange={(event) => setDeleteData(event.target.checked)} className="accent-[rgb(var(--accent-rgb))]" />
        Also delete what Ensemble read from {entry.name}
      </label>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn border-danger/50 text-danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
          {disconnect.isPending ? <Spinner size={12} /> : null} Disconnect
        </button>
      </div>
    </div>
  );
}

// ── remote MCP tools ───────────────────────────────────────────────────────

export function McpPanel({ entry, connection }: { entry: Pick<CatalogEntry, "id" | "name" | "vendor" | "state"> & Partial<Pick<CatalogEntry, "mcp" | "auth" | "category" | "logo" | "tagline" | "featured" | "reads" | "writes" | "status">>; connection?: McpConnection }) {
  const toast = useToast();
  const client = useQueryClient();
  const refresh = useRefreshConnections();
  const [confirming, setConfirming] = useState(false);
  const status = connection?.status ?? entry.state.mcp?.status;
  const lastError = connection?.lastError ?? entry.state.mcp?.lastError ?? null;
  const custom = Boolean(connection && (!connection.serverId || connection.serverId.startsWith("custom-")));
  const publicOnly = status === "connected" && !custom && (connection?.auth ?? entry.state.mcp?.auth) === "none" && Boolean(entry.mcp) && !entry.mcp?.open;
  const account = connection?.account ?? entry.state.mcp?.account ?? null;
  const add = useMcpConnect({
    target: () =>
      custom && connection
        ? { url: connection.url, name: connection.name, returnTo: browser.returnTo(`mcp:${connection.id}`) }
        : { serverId: entry.id, returnTo: browser.returnTo(entry.id) },
    label: entry.name,
  });
  const remove = useMutation({
    mutationFn: () => connectorsApi.removeMcp(connection!.id),
    onSuccess: () => {
      toast(`${entry.name} tools removed.`);
      setConfirming(false);
      refresh();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const reload = useMutation({
    mutationFn: () => connectorsApi.refreshMcpTools(connection!.id),
    onSuccess: () => refresh(),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const setDisabled = useMutation({
    mutationFn: (disabledTools: string[]) => connectorsApi.setMcpDisabledTools(connection!.id, disabledTools),
    onMutate: (disabledTools) => {
      const previous = client.getQueryData<{ connections: McpConnection[] }>(CONNECTOR_QUERY.mcp);
      client.setQueryData<{ connections: McpConnection[] }>(CONNECTOR_QUERY.mcp, (old) =>
        old ? { connections: old.connections.map((row) => (row.id === connection!.id ? { ...row, disabledTools } : row)) } : old,
      );
      return { previous };
    },
    onError: (error, _value, context) => {
      if (context?.previous) client.setQueryData(CONNECTOR_QUERY.mcp, context.previous);
      toast((error as Error).message, { tone: "error" });
    },
  });
  const tools = connection?.tools ?? [];
  const disabled = new Set(connection?.disabledTools ?? []);
  const on = tools.filter((tool) => !disabled.has(tool.name)).length;
  return (
    <section className="rounded-xl border border-line" aria-label={`${entry.name} tools`} data-testid="mcp-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
            <Wrench size={13} className="text-muted" aria-hidden /> Tools from {entry.name}
            {status === "connected" ? (
              publicOnly ? <Tag tone="orange">connected · public data only</Tag> : <Tag tone="green">connected</Tag>
            ) : status === "pending" ? <Tag tone="blue">waiting for approval</Tag> : status === "error" ? <Tag tone="red">error</Tag> : status === "disabled" ? <Tag tone="gray">off</Tag> : null}
          </div>
          <div className="text-[12.5px] text-muted">
            {status === "connected"
              ? `${publicOnly ? "Public data only — sign in to use your account. " : account ? `Signed in as ${account}. ` : ""}${
                  tools.length
                    ? `${on} of ${tools.length} tools on. Tools that change things wait for your Apply.`
                    : `${entry.state.mcp?.toolCount ?? 0} tools. Tools that change things wait for your Apply.`
                }`
              : status === "pending"
                ? `Finish approving on ${brand(entry)}'s site to turn the tools on.`
                : status === "error"
                  ? lastError ?? "The server stopped answering."
                  : status === "disabled"
                    ? "Turned off."
                    : `Gives the assistant ${brand(entry)}'s own tools through its MCP server. Changes wait for your Apply.`}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {(status === "pending" || status === "error") && !add.asksForToken && !entry.mcp?.token?.only ? (
            <button type="button" className="btn" disabled={add.pending} onClick={() => add.connect(entry.mcp?.connection ? { useConnection: true } : undefined)}>
              {add.pending ? <Spinner size={12} /> : <Plug size={12} />} {status === "pending" ? "Continue sign-in" : status === "error" ? "Reconnect" : "Connect tools"}
            </button>
          ) : null}
          {status === "connected" && connection ? (
            <button type="button" className="btn-ghost text-[12.5px]" disabled={reload.isPending} onClick={() => reload.mutate()}>
              {reload.isPending ? <BrandMorph size={14} kind="beacon" state="loop" /> : <RefreshCw size={11} />} Refresh tools
            </button>
          ) : null}
          {connection && !confirming ? (
            <button type="button" className="btn-ghost text-[12.5px]" onClick={() => setConfirming(true)}>
              {status === "pending" ? "Cancel" : "Remove"}
            </button>
          ) : null}
        </div>
      </div>
      {entry.mcp && entry.auth && !custom && status !== "connected" && hasWrittenGuide(entry as CatalogEntry, "mcp") ? (
        <div className="px-3 pb-2 sm:px-4">
          <ConnectGuide guide={connectorGuide(entry as CatalogEntry, "mcp")!} />
        </div>
      ) : null}
      {entry.mcp && !custom && (!status || publicOnly || ((status === "pending" || status === "error") && entry.mcp.token?.only)) ? (
        <div className="px-3 pb-3 sm:px-4">
          <McpConnectWay entry={entry as CatalogEntry} primary={!status || publicOnly} />
        </div>
      ) : null}
      {add.problem ? (
        <div className="px-3 pb-3 sm:px-4">
          {add.asksForToken ? (
            <McpTokenPrompt label={entry.name} problem={add.problem} pending={add.pending} onSubmit={(token) => add.connect({ token })} onCancel={add.clear} />
          ) : (
            <p role="alert" className="text-[12.5px] text-danger">
              {add.problem.message}
            </p>
          )}
        </div>
      ) : null}
      {confirming ? (
        <div role="group" aria-label={`Remove ${entry.name} tools`} className="mx-3 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] sm:mx-4">
          <span className="min-w-0 flex-1">Remove {entry.name}'s tools? The assistant stops using them right away.</span>
          <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
            Keep
          </button>
          <button type="button" className="btn border-danger/50 text-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </button>
        </div>
      ) : null}
      {status === "connected" && tools.length ? (
        <ul className="max-h-72 divide-y divide-[var(--line)] overflow-y-auto border-t border-line px-3 sm:px-4" aria-label="Tools">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">
                  {tool.title || tool.name}
                  {tool.readOnly ? <Tag tone="gray">reads</Tag> : <Tag tone="blue">changes, asks first</Tag>}
                </div>
                {tool.description ? <div className="line-clamp-2 text-[12px] text-muted">{tool.description}</div> : null}
              </div>
              <Toggle
                label={`Use ${tool.title || tool.name}`}
                checked={!disabled.has(tool.name)}
                onChange={(value) => setDisabled.mutate(value ? [...disabled].filter((name) => name !== tool.name) : [...disabled, tool.name])}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ── import ───────────────────────────────────────────────────────────────

function ImportPanel({ entry, onImport }: { entry: CatalogEntry; onImport: (source: string) => void }) {
  const spec = entry.import!;
  const ways = [spec.api ? (entry.state.connected ? "your connection" : "a pasted token") : null, spec.files?.length ? `an export (${spec.files.join(", ")})` : null].filter(Boolean);
  return (
    <section className="rounded-xl border border-line px-3 py-3 sm:px-4" aria-label={`Import from ${entry.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="text-[13.5px] font-medium">Import from {entry.name}</div>
          <ul className="mt-1 space-y-0.5 text-[12.5px] text-muted">
            {spec.brings.map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
          {IMPORT_TIPS[entry.id] ? <p className="mt-1.5 text-[12.5px] text-ink/85">{IMPORT_TIPS[entry.id]}</p> : null}
          <p className="mt-1 text-[12px] text-faint">
            {ways.length ? `Uses ${ways.join(" or ")}. ` : ""}Running it again updates what came across and never makes duplicates.
          </p>
        </div>
        <button type="button" className="btn shrink-0" onClick={() => onImport(spec.source)}>
          <FileUp size={12} /> Import…
        </button>
      </div>
    </section>
  );
}
