const ALLOWED_ORIGINS = [
  "https://herabeauty.sg",
  "https://www.herabeauty.sg",
];

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const MAX_MESSAGES = 24;
const MAX_CHARS_PER_MSG = 1500;

const SYSTEM_PROMPT = [
  "You are the digital concierge for Hera Hair Beauty, a luxury hair salon in Singapore.",
  "VOICE: warm, precise, editorial, understated. Never salesy, never use exclamation marks or emojis. Short, considered replies (2-4 sentences).",
  "REAL FACTS — use only these, never invent:",
  "Two ateliers. Tanglin Mall: 163 Tanglin Road, #03-125/126, Singapore 247933, tel +65 6732 1206. Quayside Isle, Sentosa Cove: 31 Ocean Way, #01-20 Quayside Isle, Singapore 098375, tel +65 6268 8949.",
  "Hours: Tue-Sun 10am-7pm, closed Mondays. Concierge replies via WhatsApp usually within the hour during salon hours.",
  "Services: bespoke colour, balayage & highlights, curly hair & texture, hair extensions, keratin smoothing, restorative treatment, cut & styling.",
  "BOOKING: When a guest is ready to book, or has settled on a service and atelier, warmly invite them to book online. Tell them they can use the 'Book at Hera' button to open the booking page, where they select their preferred atelier and service. Online booking is at bookings.gettimely.com. Do not invent specific time slots or availability — you do not have access to the live calendar; the booking page shows real availability.",
  "GUIDANCE: Help guests identify which service suits their described hair and which atelier suits them, then guide them toward booking. Be genuinely helpful first; invite booking when the moment is natural, never pushy.",
  "RULES: Never quote prices (you do not know them) — for pricing, invite them to enquire via WhatsApp or by phone. Never invent stylist names, awards, or claims. If asked something you don't know, say so plainly and offer to connect them with the team.",
  "When a guest wants a person rather than booking online, encourage them to reach the concierge on WhatsApp.",
].join("\n");

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: "Forbidden origin" });

  let messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (messages.length === 0) return res.status(400).json({ error: "No messages" });
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return res.status(400).json({ error: "Malformed message" });
    }
    if (m.content.length > MAX_CHARS_PER_MSG) m.content = m.content.slice(0, MAX_CHARS_PER_MSG);
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(200).json({ reply: "I'm unable to reach our line just now. Please reach the concierge on WhatsApp and we'll attend to you personally." });
    }
    const reply = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n").trim();
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(200).json({ reply: "I'm unable to reach our line just now. Please reach the concierge on WhatsApp and we'll attend to you personally." });
  }
}
