import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.endsWith("package-lock.json"));

const findings = [];
const assignment = /\b(D360_API_KEY|D360_WEBHOOK_PASSWORD|SUPABASE_SERVICE_ROLE_KEY|WHATSAPP_ACCESS_TOKEN|META_APP_SECRET|CRON_SECRET)[ \t]*=[ \t]*([^\s#"']{12,})/g;
const tokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /["']D360-API-KEY["']\s*:\s*["'][^"']{12,}["']/g,
];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const match of text.matchAll(assignment)) {
    const value = match[2] ?? "";
    if (!value.startsWith("your-") && !value.includes("example")) {
      findings.push(`${file}: possible populated ${match[1]}`);
    }
  }
  for (const pattern of tokenPatterns) {
    if (pattern.test(text)) findings.push(`${file}: possible credential pattern`);
    pattern.lastIndex = 0;
  }
}

if (findings.length > 0) {
  console.error("Credential scan failed:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`Credential scan passed across ${files.length} tracked files.`);
