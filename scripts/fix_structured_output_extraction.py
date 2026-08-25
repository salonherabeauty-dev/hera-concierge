from pathlib import Path

path = Path("src/ai/receptionist.ts")
source = path.read_text(encoding="utf-8")

anchors = [
    ('''      return agent.generate({
        messages: historyMessages(
          input.history,
          input.context.message.id,
          input.interpreted,
        ),
        timeout: 75_000,
      });
''', '''      const generated = await agent.generate({
        messages: historyMessages(
          input.history,
          input.context.message.id,
          input.interpreted,
        ),
        timeout: 75_000,
      });
      void generated.output;
      return generated;
'''),
    ('''      return verifier.generate({
        prompt: JSON.stringify({
          conversationHistory: input.history.map((message) => ({
            direction: message.direction,
            text: message.text.slice(0, 5000),
            createdAt: message.createdAt,
          })),
          clientMessage: input.originalMessage,
          proposedDecision: input.decision,
          approvedEvidence: input.evidence,
        }),
        timeout: 50_000,
      });
''', '''      const generated = await verifier.generate({
        prompt: JSON.stringify({
          conversationHistory: input.history.map((message) => ({
            direction: message.direction,
            text: message.text.slice(0, 5000),
            createdAt: message.createdAt,
          })),
          clientMessage: input.originalMessage,
          proposedDecision: input.decision,
          approvedEvidence: input.evidence,
        }),
        timeout: 50_000,
      });
      void generated.output;
      return generated;
'''),
    ('''      return verifier.generate({
        prompt: JSON.stringify({
          conversationHistory: input.history.map((message) => ({
            direction: message.direction,
            text: message.text.slice(0, 5000),
            createdAt: message.createdAt,
          })),
          clientMessage: input.originalMessage,
          proposedDecision: input.decision,
          approvedEvidence: input.evidence,
          deterministicPolicy: input.policy,
          finalHandoffAssessment: input.handoff,
          exactPostPolicyDraft: input.draftReply,
          deterministicDraftQuality: input.deterministicDraftQuality,
        }),
        timeout: 50_000,
      });
''', '''      const generated = await verifier.generate({
        prompt: JSON.stringify({
          conversationHistory: input.history.map((message) => ({
            direction: message.direction,
            text: message.text.slice(0, 5000),
            createdAt: message.createdAt,
          })),
          clientMessage: input.originalMessage,
          proposedDecision: input.decision,
          approvedEvidence: input.evidence,
          deterministicPolicy: input.policy,
          finalHandoffAssessment: input.handoff,
          exactPostPolicyDraft: input.draftReply,
          deterministicDraftQuality: input.deterministicDraftQuality,
        }),
        timeout: 50_000,
      });
      void generated.output;
      return generated;
'''),
]

for before, after in anchors:
    if before not in source:
        raise RuntimeError("Structured generation anchor was not found")
    source = source.replace(before, after, 1)

path.write_text(source, encoding="utf-8")

Path("tests/structuredOutputExtractionFailover.test.ts").write_text(
    '''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("structured output is forced inside the model failover boundary", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const forcedExtractions = source.match(/void generated\.output;/g) ?? [];
  assert.equal(forcedExtractions.length, 3);
  assert.match(source, /generateWithStructuredFallback[\s\S]*void generated\.output/);
});

test("lazy output extraction failures cannot bypass independent model retry", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /structured_generation_failed/);
  assert.match(source, /fallbackModel: nextModel/);
  assert.match(source, /if \(!canRetry\) throw error/);
});
''',
    encoding="utf-8",
)
