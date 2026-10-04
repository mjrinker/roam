/** Where an item lands when it is moved to a new index among the loaded items. */
export function moveTo<T extends { id: string }>(
  items: readonly T[],
  from: number,
  to: number
): { items: T[]; afterId: string | null } | null {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return null;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  // The move API takes "just after this item" (null = the very top).
  return { items: next, afterId: next[to - 1]?.id ?? null };
}
