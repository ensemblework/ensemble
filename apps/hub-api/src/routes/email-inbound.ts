import type { FastifyInstance, FastifyRequest } from "fastify";
import PostalMime, { addressParser, type Address } from "postal-mime";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { z } from "zod";
import { RESEND_API, sendMail } from "../lib/resend-email.js";

export const EMAIL_INBOUND_PATH = "/api/email/inbound";

const emailAddress = z.string().email();
const eventType = z.object({ type: z.string() });
const receivedEvent = z.object({
  data: z.object({
    email_id: z.string().uuid().transform((id) => id.toLowerCase()),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    received_for: z.array(z.string()).optional(),
  }),
});
const receivedEmail = z.object({
  raw: z.object({ download_url: z.string().url() }),
});
type Received = z.infer<typeof receivedEvent>["data"];
type Config = NonNullable<ReturnType<typeof readConfig>>;

function addresses(list: Address[]): string[] {
  return list.flatMap((entry) => (entry.group ?? [entry]).flatMap(({ address }) =>
    emailAddress.safeParse(address).success && address ? [address] : [],
  ));
}

function mailboxes(values: string[]): string[] {
  return values.flatMap((value) => addresses(addressParser(value, { flatten: true })));
}

function domain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function readConfig(log: FastifyInstance["log"]) {
  const from = process.env.EMAIL_FROM_SUPPORT?.trim();
  const to = process.env.EMAIL_FORWARD_TO?.trim();
  const secret = process.env.EMAIL_INBOUND_WEBHOOK_SECRET?.trim();
  const apiKey = process.env.EMAIL_INBOUND_API_KEY?.trim();
  if (!from && !to && !secret && !apiKey) return null;

  const [sender, ...extraSenders] = from ? mailboxes([from]) : [];
  const [noReply] = mailboxes([process.env.EMAIL_FROM ?? ""]);
  if (process.env.EMAIL_PROVIDER !== "resend" || !apiKey || !from || /[\r\n]/.test(from) || !sender || extraSenders.length ||
      !noReply || !to || !emailAddress.safeParse(to).success || domain(to) === domain(sender) ||
      sender.toLowerCase() === noReply.toLowerCase() || !secret?.startsWith("whsec_")) {
    log.warn("Inbound mail is disabled: check the Resend forwarding configuration.");
    return null;
  }
  try {
    return { apiKey, from, to, noReply: noReply.toLowerCase(), inboundDomain: domain(sender), webhook: new Webhook(secret) };
  } catch {
    log.warn("Inbound mail is disabled: the Resend webhook secret is invalid.");
    return null;
  }
}

function recipientsFor(event: Received, config: Config): string[] {
  const inbox = config.to.toLowerCase();
  if (mailboxes([event.from]).some((sender) => sender.toLowerCase() === inbox)) return [];
  const recipients = mailboxes([...event.to, ...(event.cc ?? []), ...(event.bcc ?? []), ...(event.received_for ?? [])]);
  return [...new Set(recipients.map((address) => address.toLowerCase()))]
    .filter((address) => address !== config.noReply && domain(address) === config.inboundDomain);
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class ForwardError extends Error {
  constructor(readonly stage: "receive" | "download" | "send", readonly status?: number) {
    super(`Resend forward failed at ${stage}.`);
  }
}

async function forwardEmail(event: Received, recipients: string[], config: Config): Promise<void> {
  // Resend's SDK forwards the MIME content but doesn't carry Reply-To or the original sender.
  const signal = AbortSignal.timeout(15_000);
  const received = await fetch(`${RESEND_API}/emails/receiving/${event.email_id}?html_format=cid`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal,
    redirect: "error",
  });
  if (!received.ok) throw new ForwardError("receive", received.status);
  const metadata = receivedEmail.safeParse(await received.json());
  if (!metadata.success) throw new ForwardError("receive");
  const url = new URL(metadata.data.raw.download_url);
  if (url.protocol !== "https:" || url.username || url.password) throw new ForwardError("download");
  const raw = await fetch(url, { signal, redirect: "error" });
  if (!raw.ok || !raw.body) throw new ForwardError("download", raw.status);
  const original = await PostalMime.parse(raw.body, { attachmentEncoding: "base64", forceRfc822Attachments: true });
  const [originalFrom] = original.from ? addresses([original.from]) : [];
  const sender = originalFrom ?? mailboxes([event.from])[0];
  const name = originalFrom ? original.from?.name.replace(/\s+/g, " ").trim() : undefined;
  const replyTo = addresses(original.replyTo ?? []);
  const fromLine = `Original sender: ${name ? `${name} <${sender}>` : sender ?? "(not supplied)"}`;
  const toLine = `Received for: ${recipients.join(", ")}`;

  const result = await sendMail({
    from: config.from,
    to: [config.to],
    subject: original.subject || "(no subject)",
    reply_to: replyTo.length ? replyTo : sender ? [sender] : undefined,
    text: original.text || !original.html ? `${fromLine}\n${toLine}\n\n${original.text ?? ""}` : undefined,
    html: original.html ? `<p>${escapeHtml(fromLine)}<br>${escapeHtml(toLine)}</p>${original.html}` : undefined,
    attachments: original.attachments.length ? original.attachments.map((attachment) => ({
      filename: attachment.filename ?? "attachment",
      content: String(attachment.content),
      content_type: attachment.mimeType,
      content_id: attachment.contentId?.replace(/^<|>$/g, "") || undefined,
    })) : undefined,
  }, config.apiKey, { idempotencyKey: `inbound/${event.email_id}`, signal });
  if (!result.ok) throw new ForwardError("send", result.status);
}

function signedBody(request: FastifyRequest<{ Body: Buffer }>, webhook: Webhook): unknown {
  const { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature } = request.headers;
  if (!Buffer.isBuffer(request.body) || typeof id !== "string" ||
      typeof timestamp !== "string" || !/^\d+$/.test(timestamp) || typeof signature !== "string") {
    throw new WebhookVerificationError("Missing webhook body or headers");
  }
  return webhook.verify(request.body, { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature });
}

export async function inboundEmailRoutes(app: FastifyInstance) {
  const config = readConfig(app.log);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.post<{ Body: Buffer }>(EMAIL_INBOUND_PATH, {
    bodyLimit: 256 * 1024,
    onRequest: async (_request, reply) => {
      if (!config) return reply.code(404).send({ error: "Not found." });
    },
  }, async (request, reply) => {
    if (!config) return reply.code(404).send({ error: "Not found." });
    let payload: unknown;
    try {
      payload = signedBody(request, config.webhook);
    } catch (error) {
      if (!(error instanceof WebhookVerificationError || error instanceof SyntaxError)) throw error;
      request.log.warn("Rejected inbound mail webhook signature or JSON.");
      return reply.code(400).send({ error: "Invalid webhook." });
    }

    const type = eventType.safeParse(payload);
    if (type.success && type.data.type !== "email.received") return reply.code(200).send({ ok: true });
    const event = receivedEvent.safeParse(payload);
    if (!type.success || !event.success) {
      request.log.warn("Rejected invalid inbound mail event.");
      return reply.code(400).send({ error: "Invalid mail event." });
    }
    const data = event.data.data;
    const recipients = recipientsFor(data, config);
    if (!recipients.length) return reply.code(200).send({ ok: true });
    const id = data.email_id;
    try {
      if (!(await app.prisma.inboundEmailReceipt.findUnique({ where: { id } }))) {
        await forwardEmail(data, recipients, config);
        // The provider key covers simultaneous sends and retries before this durable receipt commits.
        await app.prisma.inboundEmailReceipt.createMany({ data: [{ id }], skipDuplicates: true });
      }
    } catch (error) {
      request.log.error({
        emailId: id,
        stage: error instanceof ForwardError ? error.stage : undefined,
        providerStatus: error instanceof ForwardError ? error.status : undefined,
      }, "Inbound mail forward failed.");
      return reply.code(502).send({ error: "Could not forward mail. Retry this event." });
    }
    return reply.code(200).send({ ok: true });
  });
}
