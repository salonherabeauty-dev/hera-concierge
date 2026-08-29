import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../command-centre/src/app.ts", import.meta.url);
const apiUrl = new URL("../command-centre/src/api.ts", import.meta.url);
const advancedUrl = new URL("../public/command-centre/advanced.html", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

test("the private advanced SPA builds to a static same-origin control surface", async () => {
  const [advanced, vercel, packageJson] = await Promise.all([
    readFile(advancedUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
    readFile(packageUrl, "utf8"),
  ]);
  assert.match(advanced, /noindex, nofollow/i);
  assert.match(advanced, /\/command-centre\/assets\/app\.js/);
  assert.doesNotMatch(advanced, /https?:\/\//i);
  assert.match(vercel, /frame-ancestors 'none'/);
  assert.match(vercel, /private, no-store/);
  assert.match(vercel, /X-Robots-Tag/);
  assert.match(packageJson, /build:command-centre/);
});

test("advanced Preview GUI exposes human controls but no autonomous WhatsApp send action", async () => {
  const [app, api] = await Promise.all([readFile(appUrl, "utf8"), readFile(apiUrl, "utf8")]);
  assert.match(app, /AI delivery/i);
  assert.match(app, /Shadow (?:mode|protected)/i);
  assert.match(app, /Take over conversation/);
  assert.match(app, /Resolve and return to AI/);
  assert.match(app, /Not sent to WhatsApp/);
  assert.match(app, /Human WhatsApp replies remain in the normal WhatsApp Business App/);
  assert.doesNotMatch(api, /D360-API-KEY|messages\s*\/|sendText|provider.*send/i);
  assert.doesNotMatch(app, /Send to client|Send WhatsApp|Confirm and send/i);
});

test("advanced list views deliberately expose only phone endings", async () => {
  const app = await readFile(appUrl, "utf8");
  assert.match(app, /WhatsApp ending/);
  assert.doesNotMatch(app, /waId|phoneNumber/);
});
