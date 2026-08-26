const expectedBranch = "feat/hera-ai-receptionist-foundation";
const expectedProjectRef = "zjnbheohgwfzkmbnjqjr";

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("Stage 3-R database inspection requires Vercel Preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== expectedBranch) {
  throw new Error("Stage 3-R database inspection requires the authoritative staging branch");
}
if ((process.env.WHATSAPP_SEND_MODE ?? "shadow") !== "shadow") {
  throw new Error("Stage 3-R database inspection requires WhatsApp shadow mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("Stage 3-R database inspection refuses live confirmation");
}

const url = process.env.SUPABASE_URL?.trim();
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceRole || !url.includes(expectedProjectRef)) {
  throw new Error("Stage 3-R database inspection requires the isolated staging Supabase project");
}

const headers = {
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
  "Content-Type": "application/json",
};

const probe = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let code: string | null = null;
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null;
  } catch {
    code = null;
  }
  return { status: response.status, code };
};

const openApiResponse = await fetch(`${url}/rest/v1/`, { headers });
if (!openApiResponse.ok) {
  throw new Error(`Unable to inspect PostgREST schema: HTTP ${openApiResponse.status}`);
}
const openApi = (await openApiResponse.json()) as { paths?: Record<string, unknown> };
const rpcNames = Object.keys(openApi.paths ?? {})
  .filter((path) => path.startsWith("/rpc/"))
  .map((path) => path.slice("/rpc/".length))
  .sort();
const relevantRpcNames = rpcNames.filter((name) =>
  /(?:stage3r|sql|query|exec|migration|ddl|admin|setup)/i.test(name),
);

const runsTable = await probe("/ai_stage3r_runs?select=id&limit=1");
const casesTable = await probe("/ai_stage3r_case_results?select=id&limit=1");
const healthRpc = await probe("/rpc/ai_stage3r_certification_health", {
  method: "POST",
  body: JSON.stringify({ p_run_id: "00000000-0000-0000-0000-000000000000" }),
});

console.log(
  "HERA_STAGE3R_DATABASE_SURFACE",
  JSON.stringify({
    projectMatched: true,
    rpcCount: rpcNames.length,
    relevantRpcNames,
    stage3rRpcNames: rpcNames.filter((name) => name.startsWith("ai_stage3r_")),
    runsTable,
    casesTable,
    healthRpc,
    databaseMutationAttempted: false,
    whatsappSendAttempted: false,
    secretValuesLogged: false,
  }),
);
