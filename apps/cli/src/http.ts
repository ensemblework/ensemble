export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return fallback;
}

export async function fetchJson<T>(url: string | URL, init: RequestInit = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = await readResponseBody(response);
  if (!response.ok) throw new HttpError(response.status, errorMessage(body, response.statusText), body);
  return body as T;
}

export function bearerHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}
