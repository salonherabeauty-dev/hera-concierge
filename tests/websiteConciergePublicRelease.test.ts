import assert from "node:assert/strict";
import test from "node:test";
import type { VercelRequest } from "@vercel/node";
import {
  useWebsiteConciergePreview,
  useWebsiteConciergeProduction,
  useWebsiteConciergeRuntime,
} from "../src/website-concierge/boundary.js";
import { websiteConciergeOrigin } from "../src/website-concierge/http.js";

function request(origin?: string): VercelRequest {
  return {
    headers: origin ? { origin } : {},
  } as unknown as VercelRequest;
}

test("frozen Website Concierge permits only main in Production", () => {
  assert.equal(
    useWebsiteConciergeProduction({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(
    useWebsiteConciergeProduction({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "feat/hera-ai-receptionist-foundation",
    } as NodeJS.ProcessEnv),
    false,
  );
  assert.equal(
    useWebsiteConciergeRuntime({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "release/website-concierge-public-v1.0.1",
    } as NodeJS.ProcessEnv),
    false,
  );
});

test("approved private Preview branches remain available without widening Production", () => {
  assert.equal(
    useWebsiteConciergePreview({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "website/concierge-staging-adapter",
    } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(
    useWebsiteConciergePreview({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feat/hera-ai-receptionist-foundation",
    } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(
    useWebsiteConciergePreview({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "unapproved-branch",
    } as NodeJS.ProcessEnv),
    false,
  );
});

test("public CORS allowlist is exact for both Hera website origins", () => {
  assert.equal(
    websiteConciergeOrigin(request("https://www.herabeauty.sg")),
    "https://www.herabeauty.sg",
  );
  assert.equal(
    websiteConciergeOrigin(request("https://herabeauty.sg")),
    "https://herabeauty.sg",
  );
  assert.equal(
    websiteConciergeOrigin(request("https://herabeauty.sg.evil.example")),
    null,
  );
  assert.equal(
    websiteConciergeOrigin(request("http://www.herabeauty.sg")),
    null,
  );
  assert.equal(websiteConciergeOrigin(request()), null);
});
