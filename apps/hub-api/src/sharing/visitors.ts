/**
 * Names for people on a public link with no account: an adjective, a creature and its emoji,
 * picked from the visitor id the browser keeps, so the same tab keeps the same name. Gender
 * neutral and friendly on purpose.
 */
import { createHash } from "node:crypto";
import { VISITOR_PREFIX, type LinkVisitor } from "./context.js";

const ADJECTIVES = [
  "Curious", "Gentle", "Brave", "Sunny", "Quiet", "Witty", "Swift", "Cosmic", "Velvet", "Lucky", "Misty", "Nimble",
  "Breezy", "Cheerful", "Dapper", "Fuzzy", "Jolly", "Mellow", "Plucky", "Spry", "Starry", "Thoughtful", "Wandering", "Zesty",
];

const CREATURES: Array<[string, string]> = [
  ["Otter", "🦦"], ["Octopus", "🐙"], ["Fox", "🦊"], ["Whale", "🐋"], ["Owl", "🦉"], ["Turtle", "🐢"], ["Hedgehog", "🦔"], ["Bee", "🐝"],
  ["Butterfly", "🦋"], ["Penguin", "🐧"], ["Parrot", "🦜"], ["Snail", "🐌"], ["Crab", "🦀"], ["Flamingo", "🦩"], ["Seal", "🦭"], ["Panda", "🐼"],
  ["Sloth", "🦥"], ["Koala", "🐨"], ["Dolphin", "🐬"], ["Llama", "🦙"], ["Beaver", "🦫"], ["Peacock", "🦚"], ["Lobster", "🦞"], ["Swan", "🦢"],
];

const COLORS = ["#E8590C", "#7048E8", "#0C8599", "#2F9E44", "#D6336C", "#E67700", "#1971C2", "#C2255C", "#5F3DC4", "#087F5B"];

/** A visitor id from the browser: letters, digits and dashes, 8 to 64 long. */
export function cleanVisitorId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}

export function anonymousVisitor(visitorId: string): LinkVisitor {
  const digest = createHash("sha256").update(visitorId).digest();
  const adjective = ADJECTIVES[digest[0]! % ADJECTIVES.length]!;
  const [creature, emoji] = CREATURES[digest[1]! % CREATURES.length]!;
  return { id: `${VISITOR_PREFIX}${visitorId}`, name: `${adjective} ${creature}`, emoji, color: COLORS[digest[2]! % COLORS.length]!, signedIn: false };
}
