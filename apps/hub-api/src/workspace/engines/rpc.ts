/**
 * One JSON-lines connection to an agent process over stdio: Codex's app-server, or an ACP agent
 * (which adds `"jsonrpc": "2.0"`). Requests out and their responses in; the agent's own requests
 * (approvals, questions) answered; its notifications passed on.
 */
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

export class RpcConnection {
  private next = 0;
  private pending = new Map<number, Pending>();
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error("Not supported.");
  };

  constructor(
    private readonly write: (line: string) => void,
    private readonly options: { jsonrpc?: boolean } = {},
  ) {}

  private send(message: Record<string, unknown>): void {
    this.write(`${JSON.stringify(this.options.jsonrpc ? { jsonrpc: "2.0", ...message } : message)}\n`);
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  /** Feeds one line from the agent. */
  async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string; data?: { message?: string } } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      // A request from the agent (an approval, a question): answer it, or say why not.
      try {
        const result = await this.onRequest(message.method, message.params ?? {});
        this.send({ id: message.id, result: result ?? null });
      } catch (error) {
        const code = error instanceof Error && "code" in error && typeof error.code === "number" ? error.code : -32000;
        this.send({ id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    if (message.method) {
      this.onNotification(message.method, message.params ?? {});
      return;
    }
    const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiting) return;
    this.pending.delete(message.id as number);
    if (message.error) waiting.reject(new Error(message.error.data?.message ?? message.error.message ?? "The agent refused the request."));
    else waiting.resolve(message.result ?? {});
  }

  close(reason: string): void {
    for (const waiting of this.pending.values()) waiting.reject(new Error(reason));
    this.pending.clear();
  }
}
