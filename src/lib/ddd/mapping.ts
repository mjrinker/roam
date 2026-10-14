/**
 * Which of Roam's categories a Does the Dog Die topic belongs to, from the topic's own name (its topics are specific: "a dog dies",
 * "there are jump scares", "someone uses a racial slur"). The first matching rule wins; a topic that matches nothing is not a category
 * a viewer can choose to skip (it still shows as a community report). Changing a rule changes what is skipped from the next play, with
 * no new request to them, because moments keep their topic's name.
 */
import type { FilterCategory } from "@/lib/content-filter/categories";

const RULES: [FilterCategory, RegExp][] = [
  ["animals", /\b(dog|dogs|cat|cats|animal|animals|pet|pets|horse|horses|bird|birds|puppy|kitten|cow|pig|wolf|wolves|deer|fish|rabbit|bunny|monkey|ape|elephant|whale|dolphin)\b.*\b(die|dies|died|death|dead|kill|killed|hurt|harm|injur|abus|cruel|torture|eaten|shot|suffer)|\b(animal (cruelty|abuse|death|injury|harm)|pet dies|animals? (are|is) (hurt|killed))/i],
  ["sex", /\b(sex|sexual|sexually|rape|raped|rapes|molest|incest|prostitut|porn|orgasm)/i],
  ["nudity", /\b(nudity|nude|naked|topless|breasts?|genital|bare (butt|bottom)|full frontal)\b/i],
  ["language", /\b(swear|swearing|profanity|cursing|cuss|foul language|f-word|f-bomb|blasphem)\b/i],
  ["discrimination", /\b(racis|racial|slur|sexis|misogyn|homophob|transphob|antisemit|ableis|bigot|discriminat|hate speech|xenophob|blackface|n-word)/i],
  ["drugs", /\b(drug|drugs|alcohol|drunk|drinking|smok|cigarette|substance|overdose|addict|cocaine|heroin|marijuana|weed|vap)/i],
  ["distress", /\b(suicide|suicidal|self.?harm|child abuse|abuse|domestic violence|eating disorder|miscarriage|stillbirth|cancer|terminal|grief|bereave|bullying|trauma|mental (health|illness)|abortion)\b/i],
  ["fear", /\b(jump ?scare|scary|scares|horror|ghost|haunt|monster|spider|snake|clown|creepy|claustrophob|darkness|nightmare|demon|possess|stalk|kidnap|buried alive|drowning|heights|fire)\b/i],
  ["violence", /\b(gore|gory|blood|violence|violent|murder|stab|shoot|shot|gun|torture|war|fight|beating|decapitat|dismember|mutilat|kills?|killing|killed|dies|die|death|dead|execution|massacre|corpse|body|explosion|bomb|hostage|weapon|sword|punch|slap)/i],
];

/** Roam's category for a Does the Dog Die topic name, or null when it has none. */
export function categoryForTopic(topicName: string): FilterCategory | null {
  for (const [category, rule] of RULES) if (rule.test(topicName)) return category;
  return null;
}
