export type SupportedClientLocale = "en" | "zh" | "ms" | "ta";

const MALAY_HINTS =
  /\b(?:saya|awak|anda|tidak|tak|boleh|tolong|rambut|kulit kepala|janji temu|temu janji|bayaran balik|pampasan|kecewa|aduan|bernafas|bengkak|peguam)\b/i;

/**
 * Deterministic language routing is deliberately limited to languages for which
 * Hera has reviewed safety copy. Other languages continue through the model,
 * while deterministic emergency containment falls back to English.
 */
export function detectSupportedClientLocale(input: string): SupportedClientLocale {
  if (/[\u0B80-\u0BFF]/u.test(input)) return "ta";
  if (/[\u3400-\u9FFF]/u.test(input)) return "zh";
  if (MALAY_HINTS.test(input)) return "ms";
  return "en";
}
