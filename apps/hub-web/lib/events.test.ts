import assert from "node:assert/strict";
import test from "node:test";
import { eventSourceInit, eventsStreamUrl } from "./events";

test("the stream uses the API origin and sends cookies", () => {
  const url = eventsStreamUrl("https://api.example.com");
  assert.equal(url, "https://api.example.com/api/events");
  assert.equal(url.startsWith("/"), false);
  assert.equal(eventsStreamUrl("http://localhost:4000"), "http://127.0.0.1:4000/api/events");
  assert.deepEqual(eventSourceInit(), { withCredentials: true });
});
