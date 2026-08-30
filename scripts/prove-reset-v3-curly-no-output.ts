import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../src/config.js";
import { RESET_OPENAI_MODEL_ID } from "../src/reset/engine.js";
import { drainResetTurnJobs } from "../src/reset/worker.js";

const PROOF_BRANCH = "proof/reset-v3-curly-no-output";
const TURN_ID = "4a2f0c11-adc1-45da-8cf8-65b0242e515c";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000603";

if (process.env.VERCEL_GIT_COMMIT_REF !== PROOF_BRANCH) {
  console.log("RESET_V3_CURLY_NO_OUTPUT_PROOF_SKIPPED", JSON.stringify({
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
  }));
  process.exit(0);
}

const drain = await drainResetTurnJobs({
  turnIds: [TURN_ID],
  limit: 1,
  workerId: "reset-v3-curly-no-output-build-proof",
});

const database = getDatabaseConfig();
const client = createClient(database.url, database.serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const turnResult = await client
  .from("ai_client_turns_v3")
  .select("id,status,delivery_control,generation_runs,model_attempts,candidate_id,failure_code")
  .eq("id", TURN_ID)
  .single();
if (turnResult.error) throw turnResult.error;

const candidateResult = turnResult.data.candidate_id
  ? await client
      .from("ai_reply_candidates_v3")
      .select("id,status,body,model_id,model_attempts,evidence,validation")
      .eq("id", turnResult.data.candidate_id)
      .single()
  : { data: null, error: null };
if (candidateResult.error) throw candidateResult.error;

const [sends, outbox] = await Promise.all([
  client
    .from("ai_human_send_reservations_v3")
    .select("id", { count: "exact", head: true })
    .eq("turn_id", TURN_ID),
  client
    .from("ai_outbox")
    .select("id", { count: "exact", head: true })
    .eq("source_message_id", MESSAGE_ID),
]);
if (sends.error) throw sends.error;
if (outbox.error) throw outbox.error;

const body = candidateResult.data?.body?.trim() ?? "";
const knowledge = Array.isArray(candidateResult.data?.evidence?.knowledge)
  ? candidateResult.data.evidence.knowledge
  : [];
const evidenceCategories = [
  ...new Set(
    knowledge
      .map((item: unknown) =>
        item && typeof item === "object" && "category" in item
          ? String((item as { category: unknown }).category)
          : "",
      )
      .filter(Boolean),
  ),
].sort();

const proof = {
  turnStatus: turnResult.data.status,
  deliveryControl: turnResult.data.delivery_control,
  generationRuns: turnResult.data.generation_runs,
  turnModelAttempts: turnResult.data.model_attempts,
  candidateId: candidateResult.data?.id ?? null,
  candidateStatus: candidateResult.data?.status ?? null,
  modelId: candidateResult.data?.model_id ?? null,
  modelAttempts: candidateResult.data?.model_attempts ?? null,
  editableCharacterCount: body.length,
  editableDraft: body,
  evidenceCategories,
  validationPassed: candidateResult.data?.validation?.passed === true,
  humanSendReservations: sends.count ?? 0,
  legacyOutboxRows: outbox.count ?? 0,
  providerSendCalls: drain.providerSendCalls,
  timelyWriteCalls: drain.timelyWriteCalls,
  automaticDeliveryAllowed: false,
  drain,
};

console.log("RESET_V3_EXACT_CURLY_NO_OUTPUT_PROOF", JSON.stringify(proof));

if (
  proof.turnStatus !== "ready" ||
  proof.deliveryControl !== "human_only" ||
  proof.candidateStatus !== "ready" ||
  proof.modelId !== RESET_OPENAI_MODEL_ID ||
  ![1, 2].includes(Number(proof.modelAttempts)) ||
  proof.editableCharacterCount < 1 ||
  !proof.evidenceCategories.includes("authority") ||
  !proof.evidenceCategories.includes("service") ||
  !proof.evidenceCategories.includes("staff") ||
  !proof.evidenceCategories.includes("price") ||
  proof.validationPassed !== true ||
  proof.humanSendReservations !== 0 ||
  proof.legacyOutboxRows !== 0 ||
  proof.providerSendCalls !== 0 ||
  proof.timelyWriteCalls !== 0
) {
  throw new Error("reset_v3_exact_curly_no_output_proof_failed");
}
