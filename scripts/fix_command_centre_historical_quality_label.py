from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "command-centre" / "src" / "app.ts"
TEST = ROOT / "tests" / "commandCentreHistoricalQualityLabel.test.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


app = APP.read_text(encoding="utf-8")

app = replace_once(
    app,
    '''  const qualityIssues = stringArray(finalQuality?.issues);\n  const deliveryEligible = policyOutput?.deliveryEligible === true;\n  return `<div class="drawer-backdrop"''',
    '''  const qualityIssues = stringArray(finalQuality?.issues);\n  const deliveryEligible = policyOutput?.deliveryEligible === true;\n  const finalQualityRecorded =\n    typeof policyOutput?.deliveryEligible === "boolean" ||\n    Boolean(finalQuality) ||\n    Boolean(finalVerification) ||\n    Boolean(record(policyOutput?.initialFinalVerification));\n  const qualityStatusLabel = finalQualityRecorded\n    ? deliveryEligible\n      ? "Passed"\n      : "Blocked"\n    : "Historical";\n  const qualityStatusClass = finalQualityRecorded\n    ? deliveryEligible\n      ? "pill--normal"\n      : "pill--urgent"\n    : "";\n  const qualitySummary = qualityIssues.length\n    ? qualityIssues.join(" · ")\n    : finalQualityRecorded\n      ? String(\n          finalVerification?.summary ??\n            (deliveryEligible\n              ? "Final response passed every quality dimension."\n              : "Final response was blocked by the final quality gate."),\n        )\n      : "Historical response: no final-verifier result was recorded because this message predates the final-response quality gate.";\n  return `<div class="drawer-backdrop"''',
    "historical quality state",
)

app = replace_once(
    app,
    '''${policyTrace ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality</p><span class="pill ${deliveryEligible ? "pill--normal" : "pill--urgent"}">${deliveryEligible ? "Passed" : "Blocked"}</span></div>''',
    '''${policyTrace ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality</p><span class="pill ${qualityStatusClass}">${qualityStatusLabel}</span></div>''',
    "quality status badge",
)

app = replace_once(
    app,
    '''  <small>${qualityIssues.length ? escapeHtml(qualityIssues.join(" · ")) : escapeHtml(String(finalVerification?.summary ?? "Final response passed every quality dimension."))}</small>''',
    '''  <small>${escapeHtml(qualitySummary)}</small>''',
    "quality summary",
)

APP.write_text(app, encoding="utf-8")

TEST.write_text(
    '''import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\ntest("pre-gate response records are labelled historical instead of falsely passed", async () => {\n  const source = await readFile(\n    new URL("../command-centre/src/app.ts", import.meta.url),\n    "utf8",\n  );\n\n  assert.match(source, /const finalQualityRecorded =/);\n  assert.match(source, /: "Historical"/);\n  assert.match(\n    source,\n    /Historical response: no final-verifier result was recorded because this message predates the final-response quality gate\\./,\n  );\n  assert.match(source, /Final response was blocked by the final quality gate\\./);\n  assert.doesNotMatch(\n    source,\n    /finalVerification\\?\\.summary \\?\\? "Final response passed every quality dimension\\."/,\n  );\n});\n''',
    encoding="utf-8",
)

print("Applied historical final-response quality label correction")
