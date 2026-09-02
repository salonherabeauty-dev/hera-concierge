import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const widgetUrl = new URL(
  "../public/website-concierge-preview/widget.js",
  import.meta.url,
);

test("website management follow-up does not route Sentosa visitors into Tanglin WhatsApp", async () => {
  const source = await readFile(widgetUrl, "utf8");
  const managementBlock = source.match(
    /if \(actions\.includes\("contact_management"\)\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? "";

  assert.match(managementBlock, /Call Tanglin/);
  assert.match(managementBlock, /Call Sentosa/);
  assert.doesNotMatch(managementBlock, /tanglinWhatsAppUrl/);
});

test("Tanglin WhatsApp remains available only for an explicit Tanglin action", async () => {
  const source = await readFile(widgetUrl, "utf8");
  const tanglinBlock = source.match(
    /if \(actions\.includes\("contact_tanglin"\)\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? "";

  assert.match(tanglinBlock, /Tanglin WhatsApp/);
  assert.match(tanglinBlock, /tanglinWhatsAppUrl/);
});
