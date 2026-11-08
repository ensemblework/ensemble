/**
 * Choosing a session, the pure parts (docs/30, Choosing a session): Porter stems, anchors, rarity-weighted
 * similarity that ignores common words, the score's parts and bands, re-scoring under other weights, and
 * the config's defaults and override file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConfig, DEFAULT_SESSION_CHOICE, parseConfig, resetConfigCache, SessionChoiceConfig } from "./config.js";
import { decide, scoreCandidate, type Signals } from "./score.js";
import { anchorsOf, buildCorpus, featuresOf, similarity, stem } from "./text.js";

test("Porter stems as published, and anchors in one form", () => {
  for (const [word, want] of Object.entries({ caresses: "caress", ponies: "poni", agreed: "agre", motoring: "motor", hopping: "hop", filing: "file", relational: "relat", generalizations: "gener", ranking: "rank", ranked: "rank", adjustment: "adjust" })) assert.equal(stem(word), want, word);
  assert.deepEqual(
    [...anchorsOf("Fix rateLimiter in ./src/auth/session.ts, see #12 and ABC-7: https://github.com/acme/api/pull/7.")].sort(),
    ["code:ratelimiter", "path:session.ts", "path:src/auth/session.ts", "ref:#12", "ref:abc-7", "url:github.com/acme/api/pull/7"],
  );
});

test("similarity weighs rare shared words and ignores common ones", () => {
  const filler = Array.from({ length: 60 }, (_, index) => `Fix the update for the dashboard item ${index}`);
  const corpus = buildCorpus([...filler, "Build the ranking API with BM25", "Rate limiter for login"], Date.now() + 5000)!;
  const task = featuresOf([{ text: "Add pagination to the ranking API", weight: 3 }]);
  const related = featuresOf([{ text: "Build the ranking API with BM25", weight: 3 }]);
  const unrelated = featuresOf([{ text: "Fix the update for the dashboard", weight: 3 }]);
  const near = similarity(task, related, corpus, 0.2);
  const far = similarity(task, unrelated, corpus, 0.2);
  assert.ok(near.cosine > 0.3, `related ${near.cosine}`);
  assert.ok(far.cosine < 0.05, `unrelated ${far.cosine}`);
  assert.ok(near.shared.includes("rank") && near.shared.includes("rank api"));
  assert.ok(!near.shared.includes("the"));
  // A file nearly every task names is not an anchor.
  const common = buildCorpus(Array.from({ length: 20 }, () => "touches src/index.ts"), Date.now() + 5000)!;
  assert.deepEqual(similarity(featuresOf([{ text: "src/index.ts", weight: 1 }]), featuresOf([{ text: "src/index.ts", weight: 1 }]), common, 0.2).anchors, []);
});

const signals = (over: Partial<Signals> = {}): Signals => ({ link: null, deliverable: false, meeting: false, parentPage: false, anchors: [], topic: 0, sharedTerms: [], followUp: false, newWork: false, warm: false, fill: null, tasks: 1, ...over });

test("scores add up by weight, bands decide, and a stored decision scores again under other weights", () => {
  const linked = scoreCandidate(signals({ link: "mention", warm: true }), DEFAULT_SESSION_CHOICE);
  assert.deepEqual(linked.parts, { mention: 10, warm: 1 });
  const topical = scoreCandidate(signals({ anchors: ["path:src/a.ts"], topic: 0.5, newWork: true }), DEFAULT_SESSION_CHOICE);
  assert.deepEqual(topical.parts, { anchor: 3, topic: 3 }, "new-work wording does not count against a task anchored to the session");
  assert.equal(topical.score, 6);
  const weak = scoreCandidate(signals({ topic: 0.6, newWork: true }), DEFAULT_SESSION_CHOICE);
  assert.equal(weak.score, 2.6);
  const full = scoreCandidate(signals({ link: "link", fill: 0.8 }), DEFAULT_SESSION_CHOICE);
  assert.ok(full.tooFull && full.parts.sizeSoft === -2);
  assert.ok(scoreCandidate(signals({ tasks: 16 }), DEFAULT_SESSION_CHOICE).tooFull, "a long chain of unknown size counts as full");

  const row = (score: number, tooFull = false, at = "2026-11-01") => ({ candidate: score, score, parts: {}, tooFull, lastActiveAt: at });
  assert.equal(decide([row(6), row(11)], DEFAULT_SESSION_CHOICE).pick?.score, 11);
  assert.deepEqual(decide([row(4)], DEFAULT_SESSION_CHOICE).band, "unsure");
  assert.equal(decide([row(4)], DEFAULT_SESSION_CHOICE).pick, null);
  const handed = decide([row(10, true), row(7)], DEFAULT_SESSION_CHOICE);
  assert.equal(handed.pick?.score, 7, "the next confident one when the best is too full");
  assert.equal(decide([row(10, true)], DEFAULT_SESSION_CHOICE).handover?.score, 10);

  // Calibration: the same stored signals under other weights.
  const tuned = SessionChoiceConfig.parse({ weights: { topic: 10 }, bands: { confident: 8 } });
  assert.equal(scoreCandidate(signals({ anchors: ["path:src/a.ts"], topic: 0.5 }), tuned).score, 8);
});

test("the config fills what an override leaves out, and an invalid override is ignored", async () => {
  assert.equal(parseConfig({ weights: { mention: 4 } })?.weights.mention, 4);
  assert.equal(parseConfig({ weights: { mention: 4 } })?.weights.link, 10);
  assert.equal(parseConfig({ text: { followUp: "(" } }), null, "a broken pattern is refused");
  const dir = await mkdtemp(join(tmpdir(), "session-choice-"));
  const file = join(dir, "config.json");
  process.env.ENSEMBLE_SESSION_CHOICE_CONFIG = file;
  try {
    await writeFile(file, JSON.stringify({ version: "tuned-1", bands: { confident: 7 } }));
    resetConfigCache();
    const tuned = await activeConfig();
    assert.equal(tuned.version, "tuned-1");
    assert.equal(tuned.bands.confident, 7);
    assert.equal(tuned.bands.unsure, 3);
    await writeFile(file, "{ not json");
    resetConfigCache();
    const warned: string[] = [];
    assert.deepEqual(await activeConfig({ warn: (_data, message) => warned.push(message) }), DEFAULT_SESSION_CHOICE);
    assert.equal(warned.length, 1);
  } finally {
    delete process.env.ENSEMBLE_SESSION_CHOICE_CONFIG;
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
});
