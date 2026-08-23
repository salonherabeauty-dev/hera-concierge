import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const receptionistUrl = new URL(
  "../src/ai/receptionist.ts",
  import.meta.url,
);

test("strict knowledge search exposes only required model arguments", async () => {
  const source = await readFile(receptionistUrl, "utf8");

  assert.doesNotMatch(
    source,
    /limit:\s*z\.number\([\s\S]*?\.default\(5\)/,
    "strict tool schemas must not expose a defaulted optional limit",
  );
  assert.match(source, /execute:\s*async \(\{ query \}\) =>/);
  assert.match(
    source,
    /searchAllKnowledge\(input\.repository, query, 5\)/,
    "the bounded result limit must remain a server-side policy",
  );
});
