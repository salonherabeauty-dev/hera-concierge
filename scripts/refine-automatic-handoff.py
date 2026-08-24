from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    source = file.read_text()
    if old not in source:
        raise SystemExit(f"Reviewed source block not found in {path}: {old[:100]!r}")
    file.write_text(source.replace(old, new, 1))


# 1. Deterministic policy hardening.
replace_once(
    "src/policy/handoff.ts",
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.0.0";',
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.1.0";',
)

replace_once(
    "src/policy/handoff.ts",
    '''const URL_PATTERN = /https?:\\/\\//i;

const EMPTY_FACTS''',
    '''const URL_PATTERN = /https?:\\/\\//i;

const MANAGER_REQUEST_PATTERNS = [
  /\\b(?:manager|owner|managing director|person in charge)\\b/i,
  /经理|店长|负责人/u,
  /pengurus|orang yang bertanggungjawab/i,
  /மேலாளர்|பொறுப்பாளர்/u,
];

const OUTLET_ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  {
    canonical: "Tanglin Mall",
    patterns: [/\\btanglin(?: mall)?\\b/i],
  },
  {
    canonical: "Sentosa Quayside Isle",
    patterns: [/\\bsentosa\\b/i, /\\bquayside(?: isle)?\\b/i],
  },
];

const EMPTY_FACTS''',
)

replace_once(
    "src/policy/handoff.ts",
    '''function normalizedFacts(value: AgentHandoffFacts | undefined): AgentHandoffFacts {
  const source = value ?? EMPTY_FACTS;
  return {
    service: clean(source.service, 200),
    stylist: clean(source.stylist, 160),
    outlet: clean(source.outlet, 160),''',
    '''function canonicalOutlet(value: string | null | undefined): string | null {
  const candidate = clean(value, 160);
  if (!candidate) return null;
  for (const outlet of OUTLET_ALIASES) {
    if (outlet.patterns.some((pattern) => pattern.test(candidate))) {
      return outlet.canonical;
    }
  }
  return null;
}

function normalizedFacts(value: AgentHandoffFacts | undefined): AgentHandoffFacts {
  const source = value ?? EMPTY_FACTS;
  return {
    service: clean(source.service, 200),
    stylist: clean(source.stylist, 160),
    outlet: canonicalOutlet(source.outlet),''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  if (taskType === "medical_safety") return "Urgent client safety concern requires immediate human attention.";''',
    '''  if (taskType === "medical_safety") return "Client safety concern requires priority human review.";''',
)

replace_once(
    "src/policy/handoff.ts",
    '''    medical_safety:
      "Review immediately, ensure emergency guidance has been given, and contact the client only when it is safe and appropriate.",''',
    '''    medical_safety:
      "Review the symptoms and service context promptly, confirm that the appropriate safety guidance was given, and contact the client only within the team's professional scope.",''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  if (taskType === "booking_action") {
    return `Thank you. I’ve noted ${bookingDescription(facts)}. Our reception team will now check live availability and confirm the appointment with you.`;
  }''',
    '''  if (taskType === "booking_action") {
    return `Thank you. I’ve noted ${bookingDescription(facts)}. Our reception team will now check live availability and update you with the available option or confirmed outcome.`;
  }''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  if (taskType === "client_requested_human") {
    return "Certainly. I’ve arranged for a member of Hera’s team to take over this conversation and assist you directly.";
  }
  if (taskType === "complaint_review") {
    return "Thank you for explaining this. I’ve arranged for Hera’s management team to review the matter and continue assisting you directly.";
  }
  if (taskType === "refund_finance") {
    return "Thank you. I’ve arranged for the authorised team to review the transaction and contact you with the verified outcome.";
  }''',
    '''  if (taskType === "client_requested_human") {
    return "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.";
  }
  if (taskType === "complaint_review") {
    return "Thank you for explaining this. I’ve placed the matter with Hera’s management team for direct review and follow-up.";
  }
  if (taskType === "refund_finance") {
    return "Thank you. I’ve placed the transaction request with the authorised team for verification and a confirmed outcome.";
  }''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  if (taskType === "arrival_issue") {
    return "Thank you for updating us. I’ve alerted the outlet team so they can assist with the appointment immediately.";
  }''',
    '''  if (taskType === "arrival_issue") {
    return "Thank you for updating us. I’ve placed this in the outlet team’s urgent queue for immediate coordination.";
  }''',
)

replace_once(
    "src/policy/handoff.ts",
    '''function scopeFor(taskType: HandoffTaskType): HandoffScope {
  if (taskType === "medical_safety") return "emergency";''',
    '''function scopeFor(taskType: HandoffTaskType): HandoffScope {
  if (taskType === "medical_safety") return "full_takeover";''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  if (policy.risk === "black" || taskType === "medical_safety") return "emergency";
  if (taskType === "privacy_legal" || taskType === "security_review" || taskType === "arrival_issue") {''',
    '''  if (policy.risk === "black") return "emergency";
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(message))) return "urgent";
  if (taskType === "medical_safety") {
    return policy.risk === "red" ? "urgent" : "high";
  }
  if (taskType === "privacy_legal" || taskType === "security_review" || taskType === "arrival_issue") {''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  if (input.policy.risk === "black" || input.decision.intent === "medical_safety") {
    return "medical_safety";
  }
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) return "arrival_issue";
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "client_requested_human";
  }''',
    '''  if (input.policy.risk === "black") return "medical_safety";
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "client_requested_human";
  }
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) return "arrival_issue";
  if (input.decision.intent === "medical_safety") return "medical_safety";''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  let missingFacts = uniqueMissing(proposal.missingFacts);
  if (taskType === "booking_action") {
    missingFacts = uniqueMissing([...missingFacts, ...bookingMissingFacts(facts)]);''',
    '''  let missingFacts = uniqueMissing(proposal.missingFacts);
  if (taskType === "booking_action") {
    // Booking readiness is deterministic. Optional preferences such as stylist
    // and flexibility can never prevent a complete request from reaching reception.
    missingFacts = bookingMissingFacts(facts);''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  const requiredScope =
    input.policy.risk === "black" ? "emergency" : scopeFor(taskType);''',
    '''  const requiredScope =
    input.policy.risk === "black" ? "emergency" : scopeFor(taskType);''',
)

replace_once(
    "src/policy/handoff.ts",
    '''  const assignedRole =
    taskType === "other" && proposal.assignedRole
      ? proposal.assignedRole
      : assignedRoleFor(taskType);
  const assignedOutlet = clean(proposal.assignedOutlet, 160) ?? facts.outlet;
  const summary =
    clean(proposal.summary, 1000) ?? defaultSummary(taskType, facts);
  const requestedAction =
    clean(proposal.requestedAction, 1200) ?? defaultRequestedAction(taskType);
  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : safeAcknowledgement(proposal.clientAcknowledgement) ??
        defaultAcknowledgement(taskType, facts);''',
    '''  const managerExplicitlyRequested = MANAGER_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const assignedRole =
    taskType === "client_requested_human" && managerExplicitlyRequested
      ? "salon_manager"
      : taskType === "other" && proposal.assignedRole
        ? proposal.assignedRole
        : assignedRoleFor(taskType);
  const assignedOutlet = canonicalOutlet(proposal.assignedOutlet) ?? facts.outlet;
  // Known task classes use deterministic internal wording. The model may supply
  // custom wording only for an uncategorised task, never for booking or authority claims.
  const summary =
    taskType === "other"
      ? clean(proposal.summary, 1000) ?? defaultSummary(taskType, facts)
      : defaultSummary(taskType, facts);
  const requestedAction =
    taskType === "other"
      ? clean(proposal.requestedAction, 1200) ?? defaultRequestedAction(taskType)
      : defaultRequestedAction(taskType);
  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : taskType === "other"
        ? safeAcknowledgement(proposal.clientAcknowledgement) ??
          defaultAcknowledgement(taskType, facts)
        : defaultAcknowledgement(taskType, facts);''',
)

# 2. Verifier outputs must fail closed.
replace_once(
    "src/ai/receptionist.ts",
    'export const RESPONSE_PROMPT_VERSION = "hera-receptionist-response-1.5.0";\nexport const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.5.0";',
    'export const RESPONSE_PROMPT_VERSION = "hera-receptionist-response-1.5.1";\nexport const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.5.1";',
)

replace_once(
    "src/ai/receptionist.ts",
    '''const verificationSchema = z.object({
  approved: z.boolean(),
  correctedReply: z.string().trim().min(1).max(3500).nullable(),
  handoffApproved: z.boolean(),
  correctedHandoff: agentHandoffSchema.nullable(),
  risk: z.enum(RISK_LEVELS),
  issues: z.array(z.string().trim().min(1).max(180)).max(10),
});''',
    '''const verificationSchema = z
  .object({
    approved: z.boolean(),
    correctedReply: z.string().trim().min(1).max(3500).nullable(),
    handoffApproved: z.boolean(),
    correctedHandoff: agentHandoffSchema.nullable(),
    risk: z.enum(RISK_LEVELS),
    issues: z.array(z.string().trim().min(1).max(180)).max(10),
  })
  .superRefine((value, context) => {
    if (!value.approved && !value.correctedReply) {
      context.addIssue({
        code: "custom",
        path: ["correctedReply"],
        message: "A rejected client reply requires a complete correction.",
      });
    }
    if (!value.handoffApproved && !value.correctedHandoff) {
      context.addIssue({
        code: "custom",
        path: ["correctedHandoff"],
        message: "A rejected handoff requires a complete correction.",
      });
    }
  });''',
)

# 3. Runtime and evaluation callers may never keep rejected output.
replace_once(
    "src/worker.ts",
    '''    decision = {
      ...decision,
      reply:
        verification.approved || !verification.correctedReply
          ? decision.reply
          : verification.correctedReply,
      risk: highestRisk(decision.risk, verification.risk),
      handoff:
        verification.handoffApproved || !verification.correctedHandoff
          ? decision.handoff
          : verification.correctedHandoff,
    };''',
    '''    if (!verification.approved && !verification.correctedReply) {
      throw new Error("Verifier rejected the client reply without a correction");
    }
    if (!verification.handoffApproved && !verification.correctedHandoff) {
      throw new Error("Verifier rejected the human handoff without a correction");
    }
    decision = {
      ...decision,
      reply: verification.approved
        ? decision.reply
        : verification.correctedReply!,
      risk: highestRisk(decision.risk, verification.risk),
      handoff: verification.handoffApproved
        ? decision.handoff
        : verification.correctedHandoff!,
    };''',
)

replace_once(
    "scripts/run-model-evals.ts",
    '''    const decision: AgentDecision = {
      ...generated.decision,
      reply:
        verification.approved || !verification.correctedReply
          ? generated.decision.reply
          : verification.correctedReply,
      risk: highestRisk(generated.decision.risk, verification.risk),
    };''',
    '''    if (!verification.approved && !verification.correctedReply) {
      throw new Error("Verifier rejected the client reply without a correction");
    }
    if (!verification.handoffApproved && !verification.correctedHandoff) {
      throw new Error("Verifier rejected the human handoff without a correction");
    }
    const decision: AgentDecision = {
      ...generated.decision,
      reply: verification.approved
        ? generated.decision.reply
        : verification.correctedReply!,
      risk: highestRisk(generated.decision.risk, verification.risk),
      handoff: verification.handoffApproved
        ? generated.decision.handoff
        : verification.correctedHandoff!,
    };''',
)

# 4. Database idempotency, null-preserving fact merge and high-priority SLAs.
migration = "supabase/migrations/20260824000006_add_automatic_handoff_engine.sql"
replace_once(
    migration,
    '''create index if not exists ai_handoff_tasks_open_conversation_type_idx
  on public.ai_handoff_tasks(conversation_id, task_type, created_at desc)
  where status in ('new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal');

create or replace function public.ai_upsert_automatic_handoff(''',
    '''create index if not exists ai_handoff_tasks_open_conversation_type_idx
  on public.ai_handoff_tasks(conversation_id, task_type, created_at desc)
  where status in ('new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal');

insert into public.ai_handoff_sla_policies (
  task_type,
  priority,
  target_minutes,
  escalation_role
) values
  ('booking_action', 'high', 5, 'salon_manager'),
  ('appointment_change', 'urgent', 5, 'salon_manager'),
  ('complaint_review', 'urgent', 5, 'managing_director'),
  ('refund_finance', 'urgent', 10, 'managing_director'),
  ('medical_safety', 'high', 5, 'technical_lead'),
  ('medical_safety', 'urgent', 2, 'salon_manager'),
  ('client_requested_human', 'urgent', 2, 'salon_manager'),
  ('technical_review', 'urgent', 5, 'technical_lead'),
  ('other', 'urgent', 5, 'salon_manager')
on conflict (task_type, priority) do update
set target_minutes = excluded.target_minutes,
    escalation_role = excluded.escalation_role,
    active = true,
    updated_at = now();

create or replace function public.ai_upsert_automatic_handoff(''',
)

replace_once(
    migration,
    '''  if jsonb_typeof(coalesce(p_missing_facts, '[]'::jsonb)) <> 'array' then
    raise exception 'missing facts must be a JSON array';
  end if;

  select policy.target_minutes''',
    '''  if jsonb_typeof(coalesce(p_missing_facts, '[]'::jsonb)) <> 'array' then
    raise exception 'missing facts must be a JSON array';
  end if;

  -- Serialise every open-task decision for one conversation and task class.
  -- This closes the race where two concurrent messages could otherwise both
  -- observe no open task and create competing handoffs.
  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':' || p_task_type, 0)
  );

  select policy.target_minutes''',
)

replace_once(
    migration,
    '''        collected_facts = coalesce(collected_facts, '{}'::jsonb)
          || coalesce(p_collected_facts, '{}'::jsonb),''',
    '''        collected_facts = coalesce(collected_facts, '{}'::jsonb)
          || jsonb_strip_nulls(coalesce(p_collected_facts, '{}'::jsonb)),''',
)

replace_once(
    migration,
    '''      coalesce(p_collected_facts, '{}'::jsonb),
      coalesce(p_missing_facts, '[]'::jsonb),''',
    '''      jsonb_strip_nulls(coalesce(p_collected_facts, '{}'::jsonb)),
      coalesce(p_missing_facts, '[]'::jsonb),''',
)

# 5. Regression coverage for the hardened boundaries.
test_path = Path("tests/automaticHandoff.test.ts")
test_source = test_path.read_text()
test_source += r'''

test("booking readiness ignores optional model missing-fact noise", () => {
  const result = assessHumanHandoff({
    message: "Any stylist is fine. Root colour at Tanglin on 28 August at 2 pm.",
    conversationId: "conversation-7",
    sourceMessageId: "message-7",
    policy: policy(),
    decision: decision({
      handoff: {
        required: false,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin",
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour",
          outlet: "Tanglin",
          date: "28 August",
          time: "2 pm",
        },
        missingFacts: ["stylist", "flexibility"],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.deepEqual(result.missingFacts, []);
  assert.equal(result.assignedOutlet, "Tanglin Mall");
});

test("unknown outlets fail closed instead of entering the reception queue", () => {
  const result = assessHumanHandoff({
    message: "Root colour at Orchard on 28 August at 2 pm.",
    conversationId: "conversation-8",
    sourceMessageId: "message-8",
    policy: policy(),
    decision: decision({
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Orchard",
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour",
          outlet: "Orchard",
          date: "28 August",
          time: "2 pm",
        },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, false);
  assert.deepEqual(result.missingFacts, ["outlet"]);
  assert.equal(result.assignedOutlet, null);
});

test("non-emergency medical concerns use priority human review, not emergency mode", () => {
  const result = assessHumanHandoff({
    message: "My scalp is still irritated after yesterday's colour service.",
    conversationId: "conversation-9",
    sourceMessageId: "message-9",
    policy: policy({ risk: "red", requiresIncident: true }),
    decision: decision({
      intent: "medical_safety",
      risk: "red",
      handoff: {
        required: true,
        taskType: "medical_safety",
        scope: "full_takeover",
        priority: "urgent",
        assignedRole: "technical_lead",
        assignedOutlet: null,
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          symptoms: "persistent scalp irritation",
        },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.priority, "urgent");
});

test("an explicit manager request outranks a simultaneous arrival phrase", () => {
  const result = assessHumanHandoff({
    message: "I am at reception and need to speak to the manager now.",
    conversationId: "conversation-10",
    sourceMessageId: "message-10",
    policy: policy(),
    decision: decision({ intent: "other" }),
  });

  assert.equal(result.taskType, "client_requested_human");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.priority, "urgent");
  assert.equal(result.assignedRole, "salon_manager");
});

test("known handoff classes ignore model-written operational claims", () => {
  const result = assessHumanHandoff({
    message: "Root colour at Tanglin Mall on 28 August at 2 pm.",
    conversationId: "conversation-11",
    sourceMessageId: "message-11",
    policy: policy(),
    decision: decision({
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin Mall",
        summary: "Appointment already secured.",
        requestedAction: "Tell the client it is confirmed.",
        collectedFacts: {
          ...emptyFacts,
          service: "root colour",
          outlet: "Tanglin Mall",
          date: "28 August",
          time: "2 pm",
        },
        missingFacts: [],
        clientAcknowledgement: "Your appointment is confirmed.",
      },
    }),
  });

  assert.match(result.summary ?? "", /^Booking request:/);
  assert.match(result.requestedAction ?? "", /Check live availability in Timely/);
  assert.doesNotMatch(result.clientReplyOverride ?? "", /already secured|is confirmed/i);
});
'''
test_path.write_text(test_source)

schema_path = Path("tests/automaticHandoffSchema.test.ts")
schema_source = schema_path.read_text()
schema_source += r'''

test("automatic handoff concurrency and fact merging fail closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /hashtextextended\(p_conversation_id::text \|\| ':' \|\| p_task_type, 0\)/);
  assert.match(sql, /jsonb_strip_nulls\(coalesce\(p_collected_facts/);
  assert.match(sql, /\('booking_action', 'high', 5, 'salon_manager'\)/);
});
'''
schema_path.write_text(schema_source)

# Keep booking prompt regression expectations aligned with the hardened prompt.
replace_once(
    "tests/bookingOwnership.test.ts",
    'hera-receptionist-response-1.5.0',
    'hera-receptionist-response-1.5.1',
)
replace_once(
    "tests/bookingOwnership.test.ts",
    'hera-receptionist-verifier-1.5.0',
    'hera-receptionist-verifier-1.5.1',
)

# One-shot files remove themselves after a verified run.
Path("scripts/refine-automatic-handoff.py").unlink(missing_ok=True)
Path(".github/workflows/refine-automatic-handoff.yml").unlink(missing_ok=True)
