// ============================================================
// HERA VIRTUAL TRY-ON — BACKEND (production-grade)
// Path in repo:  api/tryon.js
// Endpoint:      https://hera-concierge.vercel.app/api/tryon
//
// Combines ChatGPT's senior-audit fixes (MIME detection, input_fidelity,
// portrait size, size limits, origin restriction, timeout handling,
// prompt-injection protection, generic user errors) PLUS in-memory rate
// limiting and a TEST MODE so your standalone test page still works while
// testing, before you lock it to your live domain.
//
// BEFORE PUBLIC LAUNCH:
//   1. Set TEST_MODE = false
//   2. Add a CAPTCHA (Cloudflare Turnstile) on the frontend
//   3. Consider Vercel Pro for longer timeouts / heavier traffic
//   4. For scale, replace in-memory rate limit with Upstash/Vercel KV
// ============================================================

export const config = {
  maxDuration: 60, // Hobby-safe. Use 300 only on Vercel Pro.
};

// TEST_MODE: while true, also accepts requests with no matching origin
// (e.g. opening tryon-test.html locally). Set FALSE before public launch.
const TEST_MODE = true;

const ALLOWED_ORIGINS = new Set([
  "https://herabeauty.sg",
  "https://www.herabeauty.sg",
]);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB cap

// Basic in-memory rate limit (per serverless instance).
const RATE_LIMIT_MAX = 8;
const RATE_LIMIT_WINDOW = 60 * 1000;
const ipHits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW) { entry.count = 0; entry.start = now; }
  entry.count++;
  ipHits.set(ip, entry);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) { if (now - v.start > RATE_LIMIT_WINDOW) ipHits.delete(k); }
  }
  return entry.count > RATE_LIMIT_MAX;
}

const LOOK_PRESETS = {
  colour: (opt) =>
    `Edit the uploaded client photo. Preserve the person's facial identity, face shape, eyes, nose, mouth, expression, skin texture, age appearance, lighting, camera angle, clothing, and background. Change only the hair colour to ${opt}. Keep the result salon-realistic with natural dimension, believable shadows, and no over-retouching. Do not alter the face or create a different person.`,
  cut: (opt) =>
    `Edit the uploaded client photo. Preserve the person's facial identity, face shape, eyes, nose, mouth, expression, skin texture, age appearance, lighting, camera angle, clothing, and background. Change only the haircut/hairstyle to ${opt}. Keep the result natural, flattering, and salon-realistic. Do not alter the face or create a different person.`,
  texture: (opt) =>
    `Edit the uploaded client photo. Preserve the person's facial identity, face shape, eyes, nose, mouth, expression, skin texture, age appearance, lighting, camera angle, clothing, and background. Change only the hair texture to ${opt}. Maintain believable natural movement, curl pattern, density, shrinkage, and Singapore-humidity realism. Do not alter the face or create a different person.`,
  volume: (opt) =>
    `Edit the uploaded client photo. Preserve the person's facial identity, face shape, eyes, nose, mouth, expression, skin texture, age appearance, lighting, camera angle, clothing, and background. Change only the hair by adding ${opt}. Keep density, length, and blending believable, like a premium salon consultation preview. Do not alter the face or create a different person.`,
};

// Whitelisted options — prevents prompt injection. MUST match the frontend.
const ALLOWED_OPTIONS = {
  colour: ["soft caramel balayage","ash blonde","warm copper","rich chocolate brunette","honey blonde highlights","natural grey blend"],
  cut: ["long layered cut","collarbone-length bob","textured pixie cut","shoulder-length with curtain bangs","blunt lob","long with face-framing layers"],
  texture: ["soft natural curls","sleek straight finish","loose beach waves","defined coily texture","gentle body wave"],
  volume: ["added length and fullness","subtle volume at the roots","long voluminous extensions","thicker fuller mid-lengths"],
};

function parseDataUrl(imageBase64) {
  const match = imageBase64.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (match) {
    const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
    return { mime, base64: match[2] };
  }
  return { mime: "image/png", base64: imageBase64 };
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const originAllowed = ALLOWED_ORIGINS.has(origin);

  if (originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (TEST_MODE) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!originAllowed && !TEST_MODE) {
    return res.status(403).json({ error: "Forbidden." });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const ip = getClientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "A little too quick — please wait a moment before trying another preview." });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY");
      return res.status(500).json({ error: "Server is not configured." });
    }

    const { imageBase64, category, option } = req.body || {};

    if (!imageBase64 || typeof imageBase64 !== "string")
      return res.status(400).json({ error: "No valid photo provided." });
    if (!category || !LOOK_PRESETS[category])
      return res.status(400).json({ error: "Invalid look category." });
    if (!option || typeof option !== "string")
      return res.status(400).json({ error: "Invalid look option." });
    if (!ALLOWED_OPTIONS[category] || ALLOWED_OPTIONS[category].indexOf(option.trim()) === -1)
      return res.status(400).json({ error: "Please choose one of the offered looks." });

    const { mime, base64 } = parseDataUrl(imageBase64);
    const imageBuffer = Buffer.from(base64, "base64");

    if (!imageBuffer.length || imageBuffer.length > MAX_IMAGE_BYTES)
      return res.status(400).json({ error: "Photo is too large or invalid. Please use a photo under 8MB." });

    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const prompt = LOOK_PRESETS[category](option.trim());

    const form = new FormData();
    form.append("model", "gpt-image-1.5");
    form.append("prompt", prompt);
    form.append("size", "1024x1536");
    form.append("quality", "medium");
    form.append("output_format", "png");
    form.append("input_fidelity", "high");
    const blob = new Blob([imageBuffer], { type: mime });
    form.append("image", blob, `client-photo.${extension}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const aiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("OpenAI image edit error:", aiRes.status, errText);
      return res.status(502).json({ error: "We could not create the preview. Please try again with a clear, front-facing, well-lit photo." });
    }

    const data = await aiRes.json();
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.error("OpenAI returned no b64_json:", JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: "No preview image was returned. Please try again." });
    }

    return res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("Try-on handler error:", err);
    const isTimeout = err && err.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? "The preview is taking longer than expected. Please try again with a smaller, clearer photo."
        : "Something went wrong creating your preview. Please try again shortly.",
    });
  }
}
