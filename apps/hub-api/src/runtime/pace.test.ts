import assert from "node:assert/strict";
import test from "node:test";
import { resetBuckets, setPaceClockForTests, setPaceRedisForTests, takeToken } from "./pace.js";

test("the gemini bucket is shared through redis and survives a local reset", async () => {
  const state = new Map<string, { tokens: number; updated: number }>();
  setPaceClockForTests(() => 1000);
  setPaceRedisForTests({
    async eval(_script, _numkeys, key, now, capacity, rate) {
      const instant = Number(now);
      const cap = Number(capacity);
      const perSecond = Number(rate);
      const prior = state.get(key) ?? { tokens: cap, updated: instant };
      const elapsed = Math.max(0, instant - prior.updated);
      let tokens = Math.min(cap, prior.tokens + elapsed * perSecond);
      let wait = 0;
      let updated = instant;
      if (tokens >= 1) tokens -= 1;
      else {
        wait = (1 - tokens) / perSecond;
        tokens = 0;
        updated = instant + wait;
      }
      state.set(key, { tokens, updated });
      return wait.toFixed(6);
    },
  });
  try {
    resetBuckets();
    const first = [];
    for (let i = 0; i < 15; i += 1) first.push(await takeToken("shared-user", "google"));
    assert.deepEqual(first, Array(15).fill(0));
    resetBuckets();
    assert.ok(Math.abs((await takeToken("shared-user", "google")) - 4) < 0.02);
    assert.equal(await takeToken("other-user", "google"), 0);
  } finally {
    setPaceRedisForTests(undefined);
    setPaceClockForTests(null);
    resetBuckets();
  }
});

test("without redis the limit stays inside this process", async (t) => {
  const url = process.env.REDIS_URL?.trim() ?? "";
  if (url && !url.startsWith("memory:")) {
    t.skip("REDIS_URL is set, so this process would share the bucket");
    return;
  }
  setPaceRedisForTests(null);
  setPaceClockForTests(() => 3000);
  try {
    resetBuckets();
    for (let i = 0; i < 15; i += 1) assert.equal(await takeToken("local-user", "google"), 0);
    resetBuckets();
    assert.equal(await takeToken("local-user", "google"), 0);
  } finally {
    setPaceRedisForTests(undefined);
    setPaceClockForTests(null);
    resetBuckets();
  }
});
