import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pre-gate response records are labelled historical instead of falsely passed", async () => {
  const source = await readFile(
    new URL("../command-centre/src/app.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /const finalQualityRecorded =/);
  assert.match(source, /: "Historical"/);
  assert.match(
    source,
    /Historical response: no final-verifier result was recorded because this message predates the final-response quality gate\./,
  );
  assert.match(source, /Final response was blocked by the final quality gate\./);
  assert.doesNotMatch(
    source,
    /finalVerification\?\.summary \?\? "Final response passed every quality dimension\."/,
  );
});
