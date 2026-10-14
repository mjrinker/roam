/**
 * Lists every Does the Dog Die topic with the Roam category its name maps to (src/lib/ddd/mapping.ts), so the rules can be checked and
 * fixed. Costs one request. Needs DDD_API_KEY.
 *
 *   npx tsx --env-file=.env.local scripts/ddd-topics.ts            (the mapped and the unmapped, side by side)
 *   npx tsx --env-file=.env.local scripts/ddd-topics.ts --unmapped (only topics that map to nothing)
 */
import { getTopics } from "@/lib/ddd/client";
import { categoryForTopic } from "@/lib/ddd/mapping";

async function main() {
  const topics = await getTopics(15_000);
  const only = process.argv.includes("--unmapped");
  const rows = topics.map((t) => ({ name: t.name, category: categoryForTopic(t.name) })).sort((a, b) => (a.category ?? "~").localeCompare(b.category ?? "~") || a.name.localeCompare(b.name));
  for (const r of rows) if (!only || r.category === null) console.log(`${(r.category ?? "(none)").padEnd(15)} ${r.name}`);
  const mapped = rows.filter((r) => r.category).length;
  console.log(`\n${rows.length} topics: ${mapped} map to a category, ${rows.length - mapped} do not.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
