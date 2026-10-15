/**
 * Arrow keys in a radio group (WAI-ARIA radio pattern): Right and Down go to the next option,
 * Left and Up to the previous one, wrapping at the ends; Home and End jump. Returns the option
 * to select, or null for any other key.
 */
export function radioKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
