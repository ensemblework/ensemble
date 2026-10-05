/**
 * In-process stand-in for the few Redis commands hub-api uses.
 * The desktop app does not ship Redis. Activity and the assistant lock
 * stay in this process, which is also the only process that runs the worker.
 */

type Entry = { value: string; expiresAt?: number };
type PubHandler = (channel: string, message: string) => void;

export function memoryRedis() {
  const strings = new Map<string, Entry>();
  const sets = new Map<string, Set<string>>();
  const channels = new Map<string, Set<PubHandler>>();

  const live = (key: string): string | null => {
    const row = strings.get(key);
    if (!row) return null;
    if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
      strings.delete(key);
      return null;
    }
    return row.value;
  };

  const redis = {
    async ping() {
      return "PONG";
    },
    async get(key: string) {
      return live(key);
    },
    async set(key: string, value: string, ...args: Array<string | number>) {
      let seconds: number | undefined;
      let onlyIfMissing = false;
      for (let i = 0; i < args.length; i += 1) {
        const flag = String(args[i]).toUpperCase();
        if (flag === "EX") {
          seconds = Number(args[i + 1]);
          i += 1;
        } else if (flag === "NX") onlyIfMissing = true;
      }
      if (onlyIfMissing && live(key) !== null) return null;
      strings.set(key, {
        value,
        expiresAt: seconds && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : undefined,
      });
      return "OK";
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) {
        if (strings.delete(key)) removed += 1;
        if (sets.delete(key)) removed += 1;
      }
      return removed;
    },
    async sadd(key: string, ...members: string[]) {
      const set = sets.get(key) ?? new Set<string>();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const member of members) {
        if (set.delete(member)) removed += 1;
      }
      return removed;
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async mget(...keys: string[]) {
      return keys.map((key) => live(key));
    },
    async quit() {
      return "OK";
    },
    disconnect() {
      strings.clear();
      sets.clear();
    },
    on() {
      return redis;
    },
    status: "ready" as const,
    async connect() {
      return;
    },
    /**
     * In-process stand-in for Redis pub/sub. The desktop app has one hub-api
     * process, so listeners on `duplicate()` are the other subscribers.
     */
    async publish(channel: string, message: string) {
      const listeners = channels.get(channel);
      if (!listeners || listeners.size === 0) return 0;
      for (const listener of [...listeners]) listener(channel, message);
      return listeners.size;
    },
    duplicate() {
      const joined = new Map<string, PubHandler>();
      const messageHandlers = new Set<PubHandler>();
      const sub = {
        status: "ready" as const,
        on(event: string, handler: PubHandler) {
          if (event === "message") messageHandlers.add(handler);
          return sub;
        },
        async connect() {
          return;
        },
        async subscribe(...names: string[]) {
          for (const channel of names) {
            if (joined.has(channel)) continue;
            const listener: PubHandler = (heard, message) => {
              for (const handler of messageHandlers) handler(heard, message);
            };
            const set = channels.get(channel) ?? new Set<PubHandler>();
            set.add(listener);
            channels.set(channel, set);
            joined.set(channel, listener);
          }
          return names.length;
        },
        async unsubscribe(...names: string[]) {
          const list = names.length > 0 ? names : [...joined.keys()];
          for (const channel of list) {
            const listener = joined.get(channel);
            if (!listener) continue;
            channels.get(channel)?.delete(listener);
            joined.delete(channel);
          }
          return list.length;
        },
        async quit() {
          await sub.unsubscribe();
          return "OK";
        },
        disconnect() {
          void sub.unsubscribe();
        },
      };
      return sub;
    },
  };
  return redis;
}
