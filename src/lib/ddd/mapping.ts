/**
 * Which of Roam's categories a Does the Dog Die topic belongs to, from the topic's own name (its ~290 topics are specific: "a dog dies",
 * "there are jump scares", "someone drowns"). Checked against their real list with scripts/ddd-topics.ts. The first matching rule wins;
 * a topic that matches nothing is not something a viewer can choose to skip (themes, tropes, representation, trivia such as "there's
 * end credits scenes?"), though it still appears as a community report. Changing a rule changes what is skipped from the next play, with no
 * new request to them, because moments keep their topic's name.
 */
import type { FilterCategory } from "@/lib/content-filter/categories";

/** Death of a bug, a dragon or a non-human character is not what anyone means to skip. */
const NOT_A_CATEGORY = /\b(a bug is killed|a dragon dies|non-human character dies|black guy dies first|a mentally ill person is violent|reality is unstable)\b/i;

const RULES: [FilterCategory, RegExp][] = [
  ["animals", /\b(dog|dogs|cat|cats|pet|pets|horse|horses|rabbit|rabbits|animal|animals)\b.*\b(die|dies|died|death|dead|kill|killed|hurt|harm|harmed|injur|abus|abused|cruel|hit by|abandoned|fighting|were harmed|torture)/i],
  ["sex", /\b(sex|sexual|sexually|sexualized|rape|raped|rapes|molest|incest|prostitut|porn|orgasm|masturbat|virginity|bdsm|bestiality|pedophil|coercion)/i],
  ["nudity", /\b(nudity|nude|naked|topless|breasts?|genital(?!.*(trauma|mutilat))|bare (butt|bottom)|full frontal|shower scenes?)\b/i],
  ["language", /\b(obscene language|profan|swear|cursing|cuss|foul language|blasphem)/i],
  ["discrimination", /(racis|racial|slur|sexis|misogyn|homophob|transphob|biphob|\baphobia|islamophob|antisemit|ableis|bigot|discriminat|hate speech|xenophob|blackface|n-word|misgender|deadnam|prejudice|stigmati|mocked|ridiculed|demoniz|misrepresent|slavery|nazis?|swastika|man in a dress|fat jokes?|persecuted|depicted predatorily|portrayed as incompetent|cultural appropriation)/i],
  ["drugs", /\b(drug|drugs|drugged|alcohol|drunk|drinking|smokes|vapes|substance|overdose|addiction|cocaine|heroin|marijuana|weed|bad trip)\b/i],
  ["distress", /(suicid|self.?harm|abuse|abusive|abuser|domestic violence|eating disorder|miscarr|stillborn|terminally ill|cancer|dementia|alzheimer|ptsd|trafficking|conversion therapy|involuntary medical|electro-therapy|abortion|gaslight|child is abandoned|\b(someone|a person|a parent|a kid|a child|a family member|a major character|a pregnant person|an elderly person|a disabled person|an lgbt person|a baby)\b.* (dies|is killed)|^someone dies$|accidentally kills a loved one|sacrifices themselves)/i],
  ["violence", /(gore|blood|violence|violent|murder|\bstab|shot\b|\bgun|torture|\bwar\b|fight|beating|beaten|brutal|decapitat|dismember|mutilat|amputation|cannibal|corpse|execut|burned alive|eaten|held under water|drowns?\b|choked|hit by (a )?(car|train|vehicle)|acid|squashed|breaks a bone|dislocat|falls? (down stairs|to their death)|crushed|hangings?|slapped|corporal punishment|police brutality|genocide|mass casualties|explosion|bomb|massacre|genital.*(trauma|mutilat)|robbed or mugged|razors?\b)/i],
  ["fear", /(jump ?scare|scary|horror|ghost|haunt|monster|spider|snake|clown|claustrophob|nightmare|demon|possess|stalk|kidnap|abduct|watched without knowing|buried alive|heights|cockroach|\bbugs\b|bedbug|rats or mice|sharks?\b|alligator|crocodile|zombie|dolls or puppets|mannequin|trypophob|facial distortion|sudden loud noises|high-pitched|screaming|sirens|flashing lights|home invasion|cult\b|tsunami|apocalypse|\bfire\b|(car|plane) crash|building collapses|animal attacks|body horror)/i],
];

/** Roam's category for a Does the Dog Die topic name, or null when it has none. */
export function categoryForTopic(topicName: string): FilterCategory | null {
  if (NOT_A_CATEGORY.test(topicName)) return null;
  for (const [category, rule] of RULES) if (rule.test(topicName)) return category;
  return null;
}
