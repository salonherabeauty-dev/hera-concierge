import assert from "node:assert/strict";
import test from "node:test";
import { verifyBasicAuthorization } from "../src/security/basicAuth.js";

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

test("360dialog webhook Basic authorization accepts the exact credentials", () => {
  assert.equal(
    verifyBasicAuthorization(
      basic("hera-receptionist", "a-long-webhook-password-with:colon"),
      "hera-receptionist",
      "a-long-webhook-password-with:colon",
    ),
    true,
  );
});

test("360dialog webhook Basic authorization rejects wrong or malformed credentials", () => {
  assert.equal(
    verifyBasicAuthorization(
      basic("hera-receptionist", "wrong-password"),
      "hera-receptionist",
      "correct-password-long-enough",
    ),
    false,
  );
  assert.equal(
    verifyBasicAuthorization(
      basic("wrong-user", "correct-password-long-enough"),
      "hera-receptionist",
      "correct-password-long-enough",
    ),
    false,
  );
  assert.equal(
    verifyBasicAuthorization("Bearer something", "hera-receptionist", "password"),
    false,
  );
  assert.equal(
    verifyBasicAuthorization("Basic !!!", "hera-receptionist", "password"),
    false,
  );
  assert.equal(verifyBasicAuthorization(undefined, "hera-receptionist", "password"), false);
});
