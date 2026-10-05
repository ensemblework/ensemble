/** Move a hit to the newest end of a Map so eviction drops the least recently used key. */
export function readLru<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  map.delete(key);
  map.set(key, value);
  return value;
}

/** Insert as newest and drop the oldest keys until the map is within `max`. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function dropWhere<K, V>(map: Map<K, V>, expired: (value: V, key: K) => boolean): void {
  for (const [key, value] of map) {
    if (expired(value, key)) map.delete(key);
  }
}
