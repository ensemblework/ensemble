export const RESEND_API = "https://api.resend.com";

type Message = {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  reply_to?: string[];
  attachments?: { filename: string; content: string; content_type: string; content_id?: string }[];
};

export function sendMail(message: Message, apiKey: string, options: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<Response> {
  return fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify(message),
    signal: options.signal ?? AbortSignal.timeout(15_000),
    redirect: "error",
  });
}
