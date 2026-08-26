const expectedBranch = "feat/hera-ai-receptionist-foundation";

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("Stage 3-R environment probe requires Vercel Preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== expectedBranch) {
  throw new Error("Stage 3-R environment probe requires the authoritative staging branch");
}
if ((process.env.WHATSAPP_SEND_MODE ?? "shadow") !== "shadow") {
  throw new Error("Stage 3-R environment probe requires WhatsApp shadow mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("Stage 3-R environment probe refuses a live confirmation");
}

const present = (name: string): boolean => Boolean(process.env[name]?.trim());
const supabaseUrl = process.env.SUPABASE_URL?.trim() ?? "";
const expectedProjectRef = "zjnbheohgwfzkmbnjqjr";

console.log(
  "HERA_STAGE3R_AUTHORITATIVE_ENV",
  JSON.stringify({
    vercelEnvironment: process.env.VERCEL_ENV,
    gitRef: process.env.VERCEL_GIT_COMMIT_REF,
    stagingProjectMatched: supabaseUrl.includes(expectedProjectRef),
    supabaseUrlPresent: present("SUPABASE_URL"),
    serviceRolePresent: present("SUPABASE_SERVICE_ROLE_KEY"),
    databaseUrlCandidates: {
      POSTGRES_URL_NON_POOLING: present("POSTGRES_URL_NON_POOLING"),
      POSTGRES_URL: present("POSTGRES_URL"),
      DATABASE_URL: present("DATABASE_URL"),
      SUPABASE_DB_URL: present("SUPABASE_DB_URL"),
      DIRECT_URL: present("DIRECT_URL"),
    },
    managementAccessCandidates: {
      SUPABASE_ACCESS_TOKEN: present("SUPABASE_ACCESS_TOKEN"),
    },
    aiGatewayCandidates: {
      AI_GATEWAY_API_KEY: present("AI_GATEWAY_API_KEY"),
      VERCEL_OIDC_TOKEN: present("VERCEL_OIDC_TOKEN"),
    },
    whatsappSendMode: process.env.WHATSAPP_SEND_MODE ?? "shadow",
    liveConfirmationEnabled:
      process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE",
    secretValuesLogged: false,
  }),
);
