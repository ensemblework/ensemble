import assert from "node:assert/strict";
import test from "node:test";
import { installStreamIteration } from "./stream-iteration";

type Iterable<T> = ReadableStream<T> & AsyncIterable<T> & { values(options?: { preventCancel?: boolean }): AsyncIterable<T> };

/** A ReadableStream class without the async iterator, as in Safari and the macOS desktop app. */
function webkitLikeStream(): typeof ReadableStream {
  class Stream<T> extends ReadableStream<T> {}
  for (const key of [Symbol.asyncIterator, "values"] as const) {
    Object.defineProperty(Stream.prototype, key, { value: undefined, writable: true, configurable: true });
  }
  return Stream as unknown as typeof ReadableStream;
}

function chunks<T>(Stream: typeof ReadableStream, values: T[], onCancel?: () => void): Iterable<T> {
  let at = 0;
  return new Stream<T>({
    pull(controller) {
      if (at < values.length) controller.enqueue(values[at++]!);
      else controller.close();
    },
    cancel: onCancel,
  }) as Iterable<T>;
}

test("streams without an async iterator can be read with for await once it is installed", async () => {
  const Stream = webkitLikeStream();
  assert.equal(typeof chunks(Stream, [1])[Symbol.asyncIterator], "undefined");

  installStreamIteration({ ReadableStream: Stream });
  const read: number[] = [];
  for await (const value of chunks(Stream, [1, 2, 3])) read.push(value);
  assert.deepEqual(read, [1, 2, 3]);

  const stream = chunks(Stream, ["a", "b"]);
  const letters: string[] = [];
  for await (const value of stream) letters.push(value);
  assert.deepEqual(letters, ["a", "b"]);
  assert.equal(stream.locked, false, "the reader is released after the loop");
});

test("leaving the loop early cancels the stream unless asked not to", async () => {
  const Stream = webkitLikeStream();
  installStreamIteration({ ReadableStream: Stream });
  let cancelled = 0;
  for await (const value of chunks(Stream, [1, 2, 3], () => (cancelled += 1))) {
    if (value === 1) break;
  }
  assert.equal(cancelled, 1);

  const kept = chunks(Stream, [1, 2, 3], () => (cancelled += 1));
  for await (const value of kept.values({ preventCancel: true })) {
    if (value === 1) break;
  }
  assert.equal(cancelled, 1, "preventCancel leaves the stream open");
  assert.equal(kept.locked, false);
});

test("a stream class that already iterates keeps its own iterator", () => {
  class Native<T> extends ReadableStream<T> {}
  const proto = Native.prototype as unknown as Record<symbol, unknown>;
  const own = proto[Symbol.asyncIterator];
  installStreamIteration({ ReadableStream: Native as unknown as typeof ReadableStream });
  assert.equal(proto[Symbol.asyncIterator], own);
  installStreamIteration({});
});
