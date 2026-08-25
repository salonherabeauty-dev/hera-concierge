from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text(encoding="utf-8")
    if content.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old[:120]!r}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "src/policy/finalResponseQuality.ts",
    'const BOOKING_COMPLETION =\n  /(?:\\b(?:i|we)(?:\'|’)ve\\s+(?:booked|confirmed|reserved|secured)|\\b(?:appointment|booking|slot)\\s+(?:is|has been|was)\\s+(?:booked|confirmed|reserved|secured)\\b|(?:已|已经).{0,12}(?:预订|预约|确认|保留)|预约.{0,12}(?:已确认|已预订)|(?:telah|sudah).{0,24}(?:menempah|mengesahkan|menyimpan slot)|(?:tempahan|janji temu).{0,24}(?:telah|sudah).{0,12}(?:disahkan|ditempah)|(?:முன்பதிவு|சந்திப்பு).{0,24}(?:உறுதிசெய்யப்பட்டது|செய்யப்பட்டது)|(?:நான்|நாங்கள்).{0,24}முன்பதிவு செய்துவிட்ட)/iu;',
    'const BOOKING_COMPLETION =\n  /(?:\\b(?:i|we)(?:\'|’)ve\\s+(?:booked|confirmed|reserved|secured)|\\b(?:appointment|booking|slot)\\s+(?:is|has been|was)\\s+(?:booked|confirmed|reserved|secured)\\b|(?:已|已经)(?:为您|为你)?(?:预订|预约|确认|保留)(?:了|好)?|(?:预约|时段).{0,8}(?:已确认|已预订|已保留)|(?:telah|sudah).{0,24}(?:menempah|mengesahkan|menyimpan slot)|(?:tempahan|janji temu).{0,24}(?:telah|sudah).{0,12}(?:disahkan|ditempah)|(?:முன்பதிவு|சந்திப்பு).{0,24}(?:உறுதிசெய்யப்பட்டது|செய்யப்பட்டது)|(?:நான்|நாங்கள்).{0,24}முன்பதிவு செய்துவிட்ட)/iu;',
)

replace_once(
    "src/policy/finalResponseQuality.ts",
    'const LIABILITY_ADMISSION =\n  /(?:\\b(?:we|hera|our stylist)\\s+(?:damaged|destroyed|ruined|caused|were at fault|are liable)|\\bour fault\\b|\\bwe accept liability\\b|(?:我们|Hera|我们的发型师).{0,12}(?:损坏|毁坏|造成|有过错|承担责任)|这是我们的错|kami|hera|stylist kami).{0,24}(?:merosakkan|menyebabkan|bersalah|bertanggungjawab)|(?:நாங்கள்|Hera|எங்கள் ஸ்டைலிஸ்ட்).{0,24}(?:சேதப்படுத்தினோம்|காரணம்|தவறு|பொறுப்பு))/iu;',
    'const LIABILITY_ADMISSION =\n  /(?:\\b(?:we|hera|our stylist)\\s+(?:damaged|destroyed|ruined|caused|were at fault|are liable)|\\bour fault\\b|\\bwe accept liability\\b|(?:我们|Hera|我们的发型师).{0,12}(?:损坏|毁坏|造成|有过错|承担责任)|这是我们的错|(?:kami|hera|stylist kami).{0,24}(?:merosakkan|menyebabkan|bersalah|bertanggungjawab)|(?:நாங்கள்|Hera|எங்கள் ஸ்டைலிஸ்ட்).{0,24}(?:சேதப்படுத்தினோம்|காரணம்|தவறு|பொறுப்பு))/iu;',
)

replace_once(
    "src/policy/finalResponseQuality.ts",
    'const EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF]/u;',
    'const MEDICAL_CLAIM =\n  /(?:\\b(?:this is|you have|you are experiencing)\\s+(?:an?\\s+)?(?:allergy|allergic reaction|chemical burn|infection|alopecia|eczema|psoriasis)\\b|\\bmedically safe\\b|(?:这是|您有|你有).{0,8}(?:过敏|化学灼伤|感染|脱发症|湿疹|银屑病)|医学上安全|(?:ini ialah|anda mempunyai|anda mengalami).{0,20}(?:alahan|reaksi alergi|melecur kimia|jangkitan|alopecia|ekzema|psoriasis)|selamat dari segi perubatan|(?:இது|உங்களுக்கு|நீங்கள் அனுபவிப்பது).{0,24}(?:ஒவ்வாமை|இரசாயன தீக்காயம்|தொற்று|அலோபீசியா|எக்சிமா|சொரியாசிஸ்)|மருத்துவ ரீதியாக பாதுகாப்பான)/iu;\nconst EMOJI = /[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF]/u;',
)

replace_once(
    "src/policy/finalResponseQuality.ts",
    '    if (/\\bdiagnos(?:e|ed|is)|medically safe\\b|诊断|医学上安全|diagnosis|selamat dari segi perubatan|நோயறிதல்|மருத்துவ ரீதியாக பாதுகாப்பான/iu.test(reply)) {',
    '    if (MEDICAL_CLAIM.test(reply)) {',
)

replace_once(
    "src/worker.ts",
    "      clientVisibleStatus: handoff.clientVisibleStatus,",
    "      clientVisibleStatus: finalQuality.passed ? finalReply : null,",
)

worker_contract = ROOT / "tests" / "automaticHandoffWorkerContract.test.ts"
worker_text = worker_contract.read_text(encoding="utf-8")
worker_test = '''\n\ntest("persisted handoff status matches the exact quality-approved client reply", async () => {\n  const worker = await readFile(\n    new URL("../src/worker.ts", import.meta.url),\n    "utf8",\n  );\n  assert.match(\n    worker,\n    /clientVisibleStatus: finalQuality\\.passed \\? finalReply : null/,\n  );\n});\n'''
if "persisted handoff status matches the exact quality-approved client reply" not in worker_text:
    worker_contract.write_text(worker_text.rstrip() + worker_test, encoding="utf-8")

quality_test = ROOT / "tests" / "finalResponseQuality.test.ts"
quality_text = quality_test.read_text(encoding="utf-8")
extra_tests = r'''

test("allows an incomplete booking clarification without inventing a handoff", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "I would like a curly haircut next week.",
    reply: "Certainly. Which Hera outlet would you prefer, and what date and time range would suit you best?",
    decision: decision({ intent: "booking" }),
    policy: policy(),
    handoff: handoff({
      createTask: false,
      taskType: "booking_action",
      scope: "task_only",
      priority: "normal",
      assignedRole: "receptionist",
      missingFacts: ["outlet", "date", "time"],
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
      },
    }),
    risk: "green",
  });
  assert.equal(result.passed, true);
});

test("blocks any human escalation claim when no durable task exists", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "Please help me with this.",
    reply: "I’ve sent your request to reception, and the team will contact you shortly.",
    decision: decision({ intent: "other" }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /not durably created/i.test(issue)));
});

test("accepts the neutral generic acknowledgement only when a human task exists", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "Please let me speak to a person.",
    reply: "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.",
    decision: decision({ intent: "other" }),
    policy: policy(),
    handoff: handoff({
      createTask: true,
      taskType: "client_requested_human",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "receptionist",
    }),
    risk: "green",
  });
  assert.equal(result.passed, true);
});

test("supports a reviewed Chinese complaint acknowledgement", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "我昨天在 Tanglin Mall 剪了卷发，层次不均，我很不满意，请经理审核。",
    reply: "感谢您说明情况，很抱歉这次卷发剪发的结果让您不满意。我已将您在 Tanglin Mall 的卷发剪发问题交给沙龙经理仔细审核。请在方便时发送清晰照片，经理会评估详情并建议下一步。",
    decision: decision({ intent: "complaint", risk: "amber", language: "Chinese" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    handoff: handoff({
      createTask: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      collectedFacts: {
        ...emptyFacts,
        service: "卷发剪发",
        outlet: "Tanglin Mall",
        other: "层次不均",
      },
    }),
    risk: "amber",
  });
  assert.equal(result.passed, true);
});

test("permits an explicit non-diagnosis disclaimer in an emergency reply", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "I cannot breathe and my face is swelling.",
    reply: "Thank you for telling me. Please stop using the product immediately. If you have breathing difficulty or severe swelling, seek urgent medical attention now. Hera’s technical lead will review the salon concern when it is safe to do so. This is not a medical diagnosis.",
    decision: decision({ intent: "medical_safety", risk: "black" }),
    policy: policy({ risk: "black", requiresIncident: true }),
    handoff: handoff({
      createTask: true,
      taskType: "medical_safety",
      scope: "emergency",
      priority: "emergency",
      assignedRole: "technical_lead",
    }),
    risk: "black",
  });
  assert.equal(result.passed, true);
});
'''
if "allows an incomplete booking clarification without inventing a handoff" not in quality_text:
    quality_test.write_text(quality_text.rstrip() + extra_tests, encoding="utf-8")

for path in [
    ROOT / "src" / "policy" / "finalResponseQuality.ts",
    ROOT / "src" / "worker.ts",
    worker_contract,
    quality_test,
]:
    path.write_text(path.read_text(encoding="utf-8").rstrip() + "\n", encoding="utf-8")

print("Refined final response quality gate")
