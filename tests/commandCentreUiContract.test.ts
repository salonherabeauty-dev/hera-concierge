import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../command-centre/src/app.ts", import.meta.url);
const apiUrl = new URL("../command-centre/src/api.ts", import.meta.url);
const indexUrl = new URL("../public/command-centre/index.html", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

test("the private SPA builds to a static same-origin control surface", async () => {
  const [index, vercel, packageJson] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
    readFile(packageUrl, "utf8"),
  ]);
  assert.match(index, /noindex, nofollow/i);
  assert.match(index, /\/command-centre\/assets\/app\.js/);
  assert.doesNotMatch(index, /https?:\/\//i);
  assert.match(vercel, /frame-ancestors 'none'/);
  assert.match(vercel, /private, no-store/);
  assert.match(vercel, /X-Robots-Tag/);
  assert.match(packageJson, /build:command-centre/);
});

test("Preview GUI exposes human controls but no WhatsApp send action", async () => {
  const [app, api] = await Promise.all([readFile(appUrl, "utf8"), readFile(apiUrl, "utf8")]);
  assert.match(app, /AI DELIVERY/);
  assert.match(app, /SHADOW/);
  assert.match(app, /Take over conversation/);
  assert.match(app, /Resolve and return to AI/);
  assert.match(app, /Not sent to WhatsApp/);
  assert.match(app, /Human WhatsApp replies remain in the normal WhatsApp Business App/);
  assert.doesNotMatch(api, /D360-API-KEY|messages\s*\/|sendText|provider.*send/i);
  assert.doesNotMatch(app, /Send to client|Send WhatsApp|Confirm and send/i);
});

test("list views deliberately expose only phone endings", async () => {
  const app = await readFile(appUrl, "utf8");
  assert.match(app, /WhatsApp ending/);
  assert.doesNotMatch(app, /waId|phoneNumber/);
});
