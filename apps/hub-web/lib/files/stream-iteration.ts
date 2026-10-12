/**
 * `for await (const chunk of stream)` over a ReadableStream. pdf.js reads every page's text this
 * way, and Safari, like the WebKit view the macOS desktop app runs in, has no such iterator, so
 * reading a PDF failed there with "undefined is not a function". This adds the standard one
 * (`values()` and `Symbol.asyncIterator`) where it is missing; browsers that have it keep theirs.
 */
type Scope = { ReadableStream?: typeof ReadableStream };

export function installStreamIteration(scope: Scope = globalThis as Scope): void {
  const proto = scope.ReadableStream?.prototype as (ReadableStream & Record<PropertyKey, unknown>) | undefined;
  if (!proto || typeof proto[Symbol.asyncIterator] === "function") return;

  async function* values<T>(this: ReadableStream<T>, options?: { preventCancel?: boolean }): AsyncGenerator<T, void, undefined> {
    const reader = this.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      // Leaving the loop early cancels the stream, as the standard iterator does.
      if (!finished && !options?.preventCancel) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const define = (key: PropertyKey) => Object.defineProperty(proto, key, { value: values, writable: true, configurable: true, enumerable: false });
  if (typeof proto.values !== "function") define("values");
  define(Symbol.asyncIterator);
}
