// ============================================================
// HERA VIRTUAL TRY-ON — BACKEND (Vercel serverless function)
// Path in your repo:  api/tryon.js
// Endpoint once deployed:  https://YOUR-PROJECT.vercel.app/api/tryon
//
// WHAT THIS DOES
//   Receives: a client photo (base64) + a chosen "look" instruction.
//   Calls OpenAI's image EDIT endpoint (gpt-image-1.5) to render the
//   new hair on the client's own photo, preserving their face as much
//   as the model allows.
//   Returns: the generated image as base64 for the website to display.
//
// SECURITY
//   Your OpenAI key lives ONLY in Vercel env vars (OPENAI_API_KEY).
//   It is never sent to the browser. Do not hardcode it here.
//
// REQUIREMENTS (one-time, on OpenAI's side)
//   1. Create an OpenAI API key at platform.openai.com
//   2. Add billing/credit
//   3. Complete "API Organization Verification" (required for GPT image models)
//
// NOTE ON TIME LIMITS
//   Image generation can take 30-120s. This function sets maxDuration
//   high. On Vercel's Hobby plan the ceiling is 60s; if you hit timeouts,
//   you may need the Pro plan (300s) — see config at bottom.
// ============================================================

export const config = {
  maxDuration: 300, // seconds; requires Vercel Pro for >60s
};

// The look-presets. Each turns a simple category + option into a
// careful prompt that tells the model to change ONLY the hair and
// keep the person's face, skin, and identity intact.
const LOOK_PRESETS = {
  colour: (opt) =>
    `Edit ONLY the hair colour of the person in this photo to a ${opt}. ` +
    `Keep their face, skin tone, facial features, expression, age, and ` +
    `everything else completely unchanged. Render realistic, natural-looking ` +
    `hair colour with believable light and shadow. Do not alter face shape ` +
    `or identity. Photorealistic, salon-quality result.`,
  cut: (opt) =>
    `Edit ONLY the hairstyle/haircut of the person in this photo to a ${opt}. ` +
    `Keep their face, skin tone, facial features, expression, age, and ` +
    `everything else unchanged. Render a realistic, flattering cut that suits ` +
    `their head shape. Do not alter face shape or identity. Photorealistic.`,
  texture: (opt) =>
    `Edit ONLY the hair texture of the person in this photo to ${opt}. ` +
    `Keep their face, skin tone, facial features, expression, age, and ` +
    `everything else unchanged. Render realistic, natural movement and ` +
    `definition in the hair. Do not alter face shape or identity. Photorealistic.`,
  volume: (opt) =>
    `Edit ONLY the hair of the person in this photo to add ${opt}. ` +
    `Keep their face, skin tone, facial features, expression, age, and ` +
    `everything else unchanged. Render realistic added length/volume with ` +
    `natural density and flow. Do not alter face shape or identity. Photorealistic.`,
};

export default async function handler(req, res) {
  // ---- CORS so your WordPress site can call this ----
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten to your domain in production
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { imageBase64, category, option } = req.body || {};

    // ---- validate input ----
    if (!imageBase64) return res.status(400).json({ error: "No photo provided." });
    if (!category || !LOOK_PRESETS[category])
      return res.status(400).json({ error: "Invalid look category." });
    if (!option || typeof option !== "string")
      return res.status(400).json({ error: "No look option provided." });

    const prompt = LOOK_PRESETS[category](option.trim());

    // ---- decode the incoming base64 photo into a Blob for the form ----
    // Accept either a data URL ("data:image/jpeg;base64,...") or raw base64.
    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;
    const imageBuffer = Buffer.from(base64Data, "base64");

    // Build multipart form for the image-edit endpoint
    const form = new FormData();
    form.append("model", "gpt-image-1.5");
    form.append("prompt", prompt);
    form.append("size", "1024x1024");
    form.append("input_fidelity", "high"); // bias toward preserving the input face
    const blob = new Blob([imageBuffer], { type: "image/png" });
    form.append("image[]", blob, "photo.png");

    // ---- call OpenAI image edit ----
    const aiRes = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("OpenAI error:", aiRes.status, errText);
      return res.status(502).json({
        error: "We couldn't create the preview just now. Please try again, or speak with our concierge.",
      });
    }

    const data = await aiRes.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(502).json({ error: "No image returned. Please try again." });
    }

    // ---- return the generated image ----
    return res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("Try-on handler error:", err);
    return res.status(500).json({
      error: "Something went wrong creating your preview. Please try again shortly.",
    });
  }
}
