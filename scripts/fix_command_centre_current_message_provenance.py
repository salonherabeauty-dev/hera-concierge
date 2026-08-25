from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if before not in source:
        raise RuntimeError(f"Missing patch anchor in {path}")
    updated = source.replace(before, after, 1)
    if updated == source:
        raise RuntimeError(f"No change made to {path}")
    file_path.write_text(updated, encoding="utf-8")


server_types = Path("src/command-centre/types.ts")
server_source = server_types.read_text(encoding="utf-8")
server_anchor = '''export interface DecisionTraceView {
  id: string;
  sourceMessageId: string;
  stage: "response" | "verification" | "policy";
  modelId: string | null;
  promptVersion: string;
  policyVersion: string;
  risk: RiskLevel;
  confidence: number;
  output: JsonValue;
  latencyMs: number | null;
  createdAt: string;
}

export interface ConversationDetail {
'''
server_replacement = '''export interface DecisionTraceView {
  id: string;
  sourceMessageId: string;
  stage: "response" | "verification" | "policy";
  modelId: string | null;
  promptVersion: string;
  policyVersion: string;
  risk: RiskLevel;
  confidence: number;
  output: JsonValue;
  latencyMs: number | null;
  createdAt: string;
}

export interface ConversationJobView {
  id: string;
  sourceMessageId: string;
  status: "pending" | "processing" | "retry" | "completed" | "dead";
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail {
'''
if server_anchor not in server_source:
    raise RuntimeError("Server type anchor was not found")
server_source = server_source.replace(server_anchor, server_replacement, 1)
server_source = server_source.replace(
    "  decisions: DecisionTraceView[];\n}",
    "  decisions: DecisionTraceView[];\n  jobs: ConversationJobView[];\n}",
    1,
)
server_types.write_text(server_source, encoding="utf-8")

client_types = Path("command-centre/src/types.ts")
client_source = client_types.read_text(encoding="utf-8")
client_anchor = '''  decisions: Array<{
    id: string;
    sourceMessageId: string;
    stage: "response" | "verification" | "policy";
    modelId: string | null;
    promptVersion: string;
    policyVersion: string;
    risk: Risk;
    confidence: number;
    output: unknown;
    latencyMs: number | null;
    createdAt: string;
  }>;
}
'''
client_replacement = '''  decisions: Array<{
    id: string;
    sourceMessageId: string;
    stage: "response" | "verification" | "policy";
    modelId: string | null;
    promptVersion: string;
    policyVersion: string;
    risk: Risk;
    confidence: number;
    output: unknown;
    latencyMs: number | null;
    createdAt: string;
  }>;
  jobs: Array<{
    id: string;
    sourceMessageId: string;
    status: "pending" | "processing" | "retry" | "completed" | "dead";
    attempts: number;
    maxAttempts: number;
    availableAt: string;
    lockedAt: string | null;
    completedAt: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}
'''
if client_anchor not in client_source:
    raise RuntimeError("Client type anchor was not found")
client_types.write_text(client_source.replace(client_anchor, client_replacement, 1), encoding="utf-8")

replace_once(
    "src/command-centre/repository.ts",
    "  ConversationMessageView,\n  ConversationSummary,\n",
    "  ConversationJobView,\n  ConversationMessageView,\n  ConversationSummary,\n",
)

replace_once(
    "src/command-centre/repository.ts",
    '''    if (decisionResult.error) throw new Error(`load conversation decision trace: ${decisionResult.error.message}`);

    const contact = object(contactResult.data, "contact");
''',
    '''    if (decisionResult.error) throw new Error(`load conversation decision trace: ${decisionResult.error.message}`);

    const transcriptMessageIds = array(messageResult.data).map((value) =>
      string(object(value, "message").id, "message id"),
    );
    const jobResult = transcriptMessageIds.length
      ? await this.database
          .from("ai_jobs")
          .select("id,source_message_id,status,attempts,max_attempts,available_at,locked_at,completed_at,last_error,created_at,updated_at")
          .in("source_message_id", transcriptMessageIds)
          .order("created_at", { ascending: false })
          .limit(300)
      : { data: [], error: null };
    if (jobResult.error) throw new Error(`load conversation jobs: ${jobResult.error.message}`);

    const contact = object(contactResult.data, "contact");
''',
)

replace_once(
    "src/command-centre/repository.ts",
    '''    const decisions: DecisionTraceView[] = array(decisionResult.data).map((value) => {
      const row = object(value, "decision trace");
      const stage = string(row.stage, "decision stage");
      if (stage !== "response" && stage !== "verification" && stage !== "policy") {
        throw new Error("Invalid decision stage");
      }
      return {
        id: string(row.id, "decision id"),
        sourceMessageId: string(row.source_message_id, "decision source message id"),
        stage,
        modelId: optionalString(row.model_id),
        promptVersion: string(row.prompt_version, "decision prompt version"),
        policyVersion: string(row.policy_version, "decision policy version"),
        risk: risk(row.risk),
        confidence: number(row.confidence, "decision confidence"),
        output: (row.output ?? {}) as JsonValue,
        latencyMs: row.latency_ms === null || row.latency_ms === undefined
          ? null
          : number(row.latency_ms, "decision latency"),
        createdAt: string(row.created_at, "decision created_at"),
      };
    });

    return { conversation, messages, tasks, notes, incidents, candidates, decisions };
''',
    '''    const decisions: DecisionTraceView[] = array(decisionResult.data).map((value) => {
      const row = object(value, "decision trace");
      const stage = string(row.stage, "decision stage");
      if (stage !== "response" && stage !== "verification" && stage !== "policy") {
        throw new Error("Invalid decision stage");
      }
      return {
        id: string(row.id, "decision id"),
        sourceMessageId: string(row.source_message_id, "decision source message id"),
        stage,
        modelId: optionalString(row.model_id),
        promptVersion: string(row.prompt_version, "decision prompt version"),
        policyVersion: string(row.policy_version, "decision policy version"),
        risk: risk(row.risk),
        confidence: number(row.confidence, "decision confidence"),
        output: (row.output ?? {}) as JsonValue,
        latencyMs: row.latency_ms === null || row.latency_ms === undefined
          ? null
          : number(row.latency_ms, "decision latency"),
        createdAt: string(row.created_at, "decision created_at"),
      };
    });

    const jobs: ConversationJobView[] = array(jobResult.data).map((value) => {
      const row = object(value, "conversation job");
      const status = string(row.status, "job status");
      if (
        status !== "pending" &&
        status !== "processing" &&
        status !== "retry" &&
        status !== "completed" &&
        status !== "dead"
      ) {
        throw new Error("Invalid conversation job status");
      }
      return {
        id: string(row.id, "job id"),
        sourceMessageId: string(row.source_message_id, "job source message id"),
        status,
        attempts: number(row.attempts, "job attempts"),
        maxAttempts: number(row.max_attempts, "job max attempts"),
        availableAt: string(row.available_at, "job available_at"),
        lockedAt: optionalString(row.locked_at),
        completedAt: optionalString(row.completed_at),
        lastError: optionalString(row.last_error),
        createdAt: string(row.created_at, "job created_at"),
        updatedAt: string(row.updated_at, "job updated_at"),
      };
    });

    return { conversation, messages, tasks, notes, incidents, candidates, decisions, jobs };
''',
)

app = Path("command-centre/src/app.ts")
app_source = app.read_text(encoding="utf-8")
old_preamble = '''  const conversation = detail.conversation;
  const activeTask = detail.tasks.find((task) => !["resolved", "cancelled"].includes(task.status));
  const latestCandidate = detail.candidates[0];
  const latestInbound = [...detail.messages].reverse().find((message) => message.direction === "inbound");
  const traceSourceMessageId = latestCandidate?.sourceMessageId ?? latestInbound?.id ?? null;
  const currentTrace = traceSourceMessageId
    ? detail.decisions.filter((decision) => decision.sourceMessageId === traceSourceMessageId)
    : [];
'''
new_preamble = '''  const conversation = detail.conversation;
  const activeTask = detail.tasks.find((task) => !["resolved", "cancelled"].includes(task.status));
  const latestInbound = [...detail.messages]
    .reverse()
    .find((message) => message.direction === "inbound");
  const latestJob = latestInbound
    ? detail.jobs.find((job) => job.sourceMessageId === latestInbound.id)
    : undefined;
  const latestCandidate = latestInbound
    ? detail.candidates.find(
        (candidate) => candidate.sourceMessageId === latestInbound.id,
      )
    : undefined;
  const previousCandidate = detail.candidates.find(
    (candidate) => candidate.sourceMessageId !== latestInbound?.id,
  );
  const traceSourceMessageId = latestInbound?.id ?? null;
  const currentTrace = traceSourceMessageId
    ? detail.decisions.filter((decision) => decision.sourceMessageId === traceSourceMessageId)
    : [];
'''
if old_preamble not in app_source:
    raise RuntimeError("Conversation provenance preamble was not found")
app_source = app_source.replace(old_preamble, new_preamble, 1)

quality_anchor = '''  const qualitySummary = qualityIssues.length
    ? qualityIssues.join(" · ")
    : finalQualityRecorded
      ? String(
          finalVerification?.summary ??
            (deliveryEligible
              ? "Final response passed every quality dimension."
              : "Final response was blocked by the final quality gate."),
        )
      : "Historical response: no final-verifier result was recorded because this message predates the final-response quality gate.";
'''
quality_replacement = quality_anchor + '''  const latestJobLabel = latestJob ? humanize(latestJob.status) : "Not queued";
  const latestJobClass =
    latestJob?.status === "completed"
      ? "pill--normal"
      : latestJob?.status === "dead"
        ? "pill--urgent"
        : "";
  const latestJobSummary = latestCandidate
    ? "A response candidate is linked to this exact client message."
    : latestJob?.status === "pending"
      ? "This exact client message is queued and has not completed processing."
      : latestJob?.status === "processing"
        ? "Hera AI is currently processing this exact client message."
        : latestJob?.status === "retry"
          ? "Processing is safely queued for retry. No reply has been sent."
          : latestJob?.status === "completed" && latestJob.lastError === "superseded_by_newer_inbound"
            ? "This message was safely superseded by a newer client turn; no stale reply was created."
            : latestJob?.status === "completed"
              ? "Processing completed without a client candidate. Review the decision trace or human-action task."
              : latestJob?.status === "dead"
                ? "Protected processing retries were exhausted and human review is required."
                : "No processing job or AI candidate is recorded for this latest client message.";
'''
if quality_anchor not in app_source:
    raise RuntimeError("Quality summary anchor was not found")
app_source = app_source.replace(quality_anchor, quality_replacement, 1)

old_cards = '''${latestCandidate ? `<div class="candidate-card"><div><p class="eyebrow">Latest AI candidate</p><span class="pill">${escapeHtml(latestCandidate.status)}</span></div><p>${escapeHtml(latestCandidate.text)}</p><small>${latestCandidate.providerMessageId ? "Provider message exists" : "Not sent to WhatsApp"}</small></div>` : ""}
${policyTrace ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality</p><span class="pill ${qualityStatusClass}">${qualityStatusLabel}</span></div>
'''
new_cards = '''${latestInbound ? `<div class="candidate-card"><div><p class="eyebrow">Latest client turn</p><span class="pill ${latestJobClass}">${escapeHtml(latestJobLabel)}</span></div><p>${escapeHtml(latestInbound.text || `[${humanize(latestInbound.kind)}]`)}</p><small>${escapeHtml(latestJobSummary)}</small></div>` : ""}
${latestCandidate ? `<div class="candidate-card"><div><p class="eyebrow">AI candidate for latest client turn</p><span class="pill">${escapeHtml(latestCandidate.status)}</span></div><p>${escapeHtml(latestCandidate.text)}</p><small>${latestCandidate.providerMessageId ? "Provider message exists" : "Not sent to WhatsApp"}</small></div>` : ""}
${!latestCandidate && previousCandidate ? `<div class="candidate-card"><div><p class="eyebrow">Previous AI candidate</p><span class="pill">Historical</span></div><p>${escapeHtml(previousCandidate.text)}</p><small>Not associated with the latest client message. Retained for audit only and not sent to WhatsApp.</small></div>` : ""}
${policyTrace ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality for latest client turn</p><span class="pill ${qualityStatusClass}">${qualityStatusLabel}</span></div>
'''
if old_cards not in app_source:
    raise RuntimeError("Candidate card anchor was not found")
app_source = app_source.replace(old_cards, new_cards, 1)

old_quality_end = '''  <small>${escapeHtml(qualitySummary)}</small>
</div>` : ""}
            ${canAddInternalNote() ? `<form class="note-form"'''
new_quality_end = '''  <small>${escapeHtml(qualitySummary)}</small>
</div>` : latestInbound && !latestCandidate ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality for latest client turn</p><span class="pill">Not recorded</span></div><p>No final-response quality record is linked to the latest client message.</p><small>${escapeHtml(latestJobSummary)}</small></div>` : ""}
            ${canAddInternalNote() ? `<form class="note-form"'''
if old_quality_end not in app_source:
    raise RuntimeError("Quality card ending anchor was not found")
app_source = app_source.replace(old_quality_end, new_quality_end, 1)
app.write_text(app_source, encoding="utf-8")

Path("tests/commandCentreCurrentMessageProvenance.test.ts").write_text(
    '''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../command-centre/src/app.ts", import.meta.url);
const repositoryUrl = new URL("../src/command-centre/repository.ts", import.meta.url);

test("the drawer binds candidates and quality evidence to the latest inbound message", async () => {
  const source = await readFile(appUrl, "utf8");
  assert.doesNotMatch(source, /const latestCandidate = detail\.candidates\[0\]/);
  assert.match(source, /candidate\.sourceMessageId === latestInbound\.id/);
  assert.match(source, /const traceSourceMessageId = latestInbound\?\.id \?\? null/);
  assert.match(source, /Previous AI candidate/);
  assert.match(source, /Not associated with the latest client message/);
  assert.match(source, /Final response quality for latest client turn/);
});

test("the Command Centre exposes processing state for each transcript message", async () => {
  const app = await readFile(appUrl, "utf8");
  const repository = await readFile(repositoryUrl, "utf8");
  assert.match(app, /detail\.jobs\.find\(\(job\) => job\.sourceMessageId === latestInbound\.id\)/);
  assert.match(app, /safely queued for retry/);
  assert.match(app, /safely superseded by a newer client turn/);
  assert.match(repository, /from\("ai_jobs"\)/);
  assert.match(repository, /source_message_id,status,attempts,max_attempts/);
  assert.match(repository, /jobs: ConversationJobView\[\]/);
});
''',
    encoding="utf-8",
)
