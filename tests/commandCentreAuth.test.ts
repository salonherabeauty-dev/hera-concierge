import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseCookies,
  safeEqual,
  serializeCookie,
} from "../src/command-centre/http.js";

const authUrl = new URL("../src/command-centre/auth.ts", import.meta.url);
const browserApiUrl = new URL("../command-centre/src/api.ts", import.meta.url);

test("command centre cookies use secure host-only boundaries", async () => {
  const [auth, browserApi] = await Promise.all([
    readFile(authUrl, "utf8"),
    readFile(browserApiUrl, "utf8"),
  ]);
  assert.match(auth, /__Host-hera_cc_access/);
  assert.match(auth, /__Host-hera_cc_refresh/);
  assert.match(auth, /__Host-hera_cc_csrf/);
  assert.match(browserApi, /__Host-hera_cc_csrf/);
  assert.doesNotMatch(browserApi, /SUPABASE_SERVICE_ROLE_KEY|D360_API_KEY|CRON_SECRET/);

  const authCookie = serializeCookie({
    name: "__Host-hera_cc_access",
    value: "token",
    maxAge: 3600,
    httpOnly: true,
  });
  assert.match(authCookie, /Secure/);
  assert.match(authCookie, /SameSite=Strict/);
  assert.match(authCookie, /HttpOnly/);
  assert.match(authCookie, /Path=\//);
  assert.doesNotMatch(authCookie, /Domain=/);
});

test("cookie parsing and CSRF comparisons fail closed", () => {
  const cookies = parseCookies("a=1; __Host-hera_cc_csrf=abc%20123; malformed");
  assert.equal(cookies.get("a"), "1");
  assert.equal(cookies.get("__Host-hera_cc_csrf"), "abc 123");
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "different"), false);
  assert.equal(safeEqual(undefined, "same"), false);
});
