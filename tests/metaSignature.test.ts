import assert from "node:assert/strict";
import test from "node:test";
import {
  createMetaSignature,
  verifyMetaSignature,
} from "../src/security/metaSignature.js";

test("verifies the exact raw Meta webhook body", () => {
  const body = Buffer.from('{"entry":[{"id":"123"}],"object":"whatsapp_business_account"}');
  const secret = "a-long-test-app-secret";
  const signature = createMetaSignature(body, secret);

  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(
    verifyMetaSignature(Buffer.from(`${body.toString()} `), signature, secret),
    false,
  );
});

test("rejects malformed and missing signatures without throwing", () => {
  const body = Buffer.from("{}");
  assert.equal(verifyMetaSignature(body, undefined, "secret"), false);
  assert.equal(verifyMetaSignature(body, "sha1=abc", "secret"), false);
  assert.equal(verifyMetaSignature(body, "sha256=not-hex", "secret"), false);
  assert.equal(verifyMetaSignature(body, ["sha256=abc"], "secret"), false);
});
