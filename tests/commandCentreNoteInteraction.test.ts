import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("internal-note editing cannot reopen the conversation or reset the drawer", async () => {
  const source = await readFile(
    new URL("../command-centre/src/app.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /target\.closest<HTMLButtonElement>\(\s*"button\[data-conversation-id\]"/,
  );
  assert.doesNotMatch(
    source,
    /target\.closest<HTMLElement>\("\[data-conversation-id\]"\)/,
  );
  assert.match(source, /noteDrafts: Record<string, string>/);
  assert.match(source, /captureDrawerRenderSnapshot/);
  assert.match(source, /drawerBody\.scrollTop = snapshot\.bodyScrollTop/);
  assert.match(source, /note\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /target instanceof HTMLTextAreaElement && target\.name === "note"/);
});
