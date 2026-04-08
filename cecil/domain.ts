import type { MemoryDomain } from "./types";

const DOMAIN_PATTERNS: [RegExp, MemoryDomain][] = [
  [/\b(code|coding|programming|software|api|database|typescript|python|javascript|git|deploy|server|docker|bug|feature|framework|library|react|node|sql|frontend|backend|devops)\b/i, "technology"],
  [/\b(revenue|startup|client|market|sales|strategy|investor|pitch|growth|roi|partnership|ceo|founder|b2b|saas|product[\s-]?market)\b/i, "business"],
  [/\b(family|friend|partner|wife|husband|daughter|son|birthday|vacation|home|personal|relationship|dating|marriage|parent|kid|child)\b/i, "personal"],
  [/\b(writing|music|art|design|creative|novel|painting|film|podcast|story|song|album|canvas|photography)\b/i, "creative"],
  [/\b(health|exercise|diet|sleep|doctor|medical|therapy|anxiety|meditation|wellness|workout|gym|mental[\s-]?health)\b/i, "health"],
  [/\b(learn|course|study|degree|school|university|lecture|training|certification|tutorial|curriculum)\b/i, "education"],
  [/\b(invest|stock|budget|savings|tax|mortgage|portfolio|crypto|retirement|banking|income|expense)\b/i, "finance"],
  [/\b(movie|game|gaming|show|tv|book|album|concert|sports|play|netflix|spotify|anime)\b/i, "entertainment"],
];

export function detectDomain(text: string): MemoryDomain {
  for (const [pattern, domain] of DOMAIN_PATTERNS) {
    if (pattern.test(text)) return domain;
  }
  return "general";
}
