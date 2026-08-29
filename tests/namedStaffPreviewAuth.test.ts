import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authUrl = new URL("../src/command-centre/auth.ts", import.meta.url);
const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const accessUrl = new URL(
  "../public/command-centre/named-staff-access.js",
  import.meta.url,
);

test("named Supabase staff sessions take precedence over the Preview-owner fallback", async () => {
  const source = await readFile(authUrl, "utf8");
  const userSession = source.indexOf("if (userId) {");
  const previewFallback = source.indexOf("if (preview) {");
  assert.ok(userSession >= 0);
  assert.ok(previewFallback >= 0);
  assert.ok(userSession < previewFallback);
  assert.match(source, /database\.auth\.getUser\(accessToken\)/);
  assert.match(source, /database\.auth\.refreshSession/);
  assert.match(source, /staff: await loadStaff\(userId\)/);
  assert.match(source, /staff: await ensurePreviewOwner\(\)/);
});

test("the protected Preview permits named staff password sign-in without weakening Vercel protection", async () => {
  const source = await readFile(authUrl, "utf8");
  assert.match(source, /database\.auth\.signInWithPassword/);
  assert.doesNotMatch(
    source,
    /Password sign-in is disabled for the protected Preview/,
  );
  assert.match(source, /process\.env\.VERCEL_ENV === "preview"/);
  assert.match(source, /branch !== "main"/);
  assert.match(source, /process\.env\.WHATSAPP_SEND_MODE === "shadow"/);
});

test("the Preview UI exposes named staff sign-in and sign-out without browser token storage", async () => {
  const [index, access] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(accessUrl, "utf8"),
  ]);
  assert.match(index, /named-staff-access\.css/);
  assert.match(index, /named-staff-access\.js/);
  assert.match(access, /\/api\/command-centre\/auth\/login/);
  assert.match(access, /\/api\/command-centre\/auth\/logout/);
  assert.match(access, /window\.location\.reload\(\)/);
  assert.match(access, /Named human authority/);
  assert.match(access, /vercel-preview-owner@herabeauty\.sg/);
  assert.doesNotMatch(access, /localStorage|sessionStorage/);
  assert.doesNotMatch(access, /SUPABASE_SERVICE_ROLE_KEY|D360_API_KEY/);
});
