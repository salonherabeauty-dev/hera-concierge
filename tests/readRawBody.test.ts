import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  PayloadTooLargeError,
  readRawBody,
} from "../src/security/readRawBody.js";

test("raw webhook reader preserves the exact request bytes", async () => {
  const body = Readable.from([Buffer.from([0x7b, 0x22]), Buffer.from([0x78, 0x22, 0x7d])]);
  const result = await readRawBody(body as never, 16);
  assert.deepEqual(result, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x7d]));
});

test("raw webhook reader rejects oversized payloads with a typed error", async () => {
  const body = Readable.from([Buffer.alloc(5), Buffer.alloc(6)]);
  await assert.rejects(
    () => readRawBody(body as never, 10),
    (error: unknown) =>
      error instanceof PayloadTooLargeError && error.maxBytes === 10,
  );
});
