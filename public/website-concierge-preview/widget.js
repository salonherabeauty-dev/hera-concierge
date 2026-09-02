const log = document.querySelector("#chat-log");
const form = document.querySelector("#chat-form");
const field = document.querySelector("#chat-field");
const sendButton = document.querySelector("#send-button");
const suggestions = document.querySelector("#suggestions");
const dynamicActions = document.querySelector("#dynamic-actions");
const contactButton = document.querySelector("#contact-button");
const contactOptions = document.querySelector("#contact-options");

const SESSION_KEY = "hera.website.concierge.session.v1";
let busy = false;
let session = readStoredSession();

function readStoredSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (
      value &&
      typeof value.sessionId === "string" &&
      typeof value.sessionToken === "string" &&
      Date.parse(value.expiresAt) > Date.now() + 60_000
    ) {
      return value;
    }
  } catch {
    // A corrupt anonymous session is safely replaced.
  }
  return null;
}

function storeSession(value) {
  session = value;
  localStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

async function ensureSession(force = false) {
  if (!force && session) return session;
  const response = await fetch("/api/website-concierge/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.sessionId || !payload?.sessionToken) {
    throw new Error(payload?.error || "The concierge session could not be opened.");
  }
  storeSession(payload);
  return payload;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}

function messageElement(role, text = "") {
  const article = document.createElement("article");
  article.className = `message message--${role}`;
  const label = document.createElement("div");
  label.className = "message__label";
  label.textContent = role === "visitor" ? "You" : "Concierge";
  const bubble = document.createElement("div");
  bubble.className = "message__bubble";
  bubble.textContent = text;
  article.append(label, bubble);
  log.append(article);
  scrollToLatest();
  return { article, bubble };
}

function statusElement(text) {
  const entry = messageElement("status", text);
  entry.article.querySelector(".message__label").textContent = "Hera Concierge";
  return entry;
}

function typingElement() {
  const entry = statusElement("");
  const typing = document.createElement("span");
  typing.className = "typing";
  typing.setAttribute("aria-label", "Hera Concierge is preparing a reply");
  typing.innerHTML = "<span></span><span></span><span></span>";
  entry.bubble.replaceChildren(typing);
  return entry;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  field.disabled = value;
  suggestions.querySelectorAll("button").forEach((button) => {
    button.disabled = value;
  });
}

function autoresize() {
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 128)}px`;
}

function safeContactActions(actions, contacts) {
  const links = [];
  if (actions.includes("book_online")) {
    links.push(["Book online", contacts.bookingUrl]);
  }
  if (actions.includes("contact_tanglin")) {
    links.push(["Tanglin WhatsApp", contacts.tanglinWhatsAppUrl]);
    links.push(["Call Tanglin", `tel:${contacts.tanglinPhone.replace(/\s+/g, "")}`]);
  }
  if (actions.includes("contact_sentosa")) {
    links.push(["Call Sentosa", `tel:${contacts.sentosaPhone.replace(/\s+/g, "")}`]);
  }
  if (actions.includes("contact_management")) {
    links.push(["Contact Hera team", contacts.tanglinWhatsAppUrl]);
  }
  if (actions.includes("seek_urgent_medical_care")) {
    links.push(["Call 995", "tel:995"]);
  }
  return links;
}

function renderDynamicActions(payload) {
  dynamicActions.replaceChildren();
  const actions = Array.isArray(payload?.items) ? payload.items : [];
  const contacts = payload?.contacts;
  if (!contacts) {
    dynamicActions.hidden = true;
    return;
  }
  for (const [label, href] of safeContactActions(actions, contacts)) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (href.startsWith("http")) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    dynamicActions.append(link);
  }
  dynamicActions.hidden = dynamicActions.childElementCount === 0;
}

function parseEventBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    return { event, payload: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

async function consumeSse(response, handlers) {
  if (!response.body) throw new Error("Streaming is unavailable in this browser.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (block && !block.startsWith(":")) {
        const parsed = parseEventBlock(block);
        if (parsed) handlers(parsed.event, parsed.payload);
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
}

async function sendQuestion(rawQuestion) {
  const question = String(rawQuestion || "").trim();
  if (!question || busy) return;
  setBusy(true);
  field.value = "";
  autoresize();
  dynamicActions.hidden = true;
  messageElement("visitor", question);
  const typing = typingElement();
  let answerEntry = null;
  let statusText = "Preparing your personalised Hera answer…";

  try {
    const credential = await ensureSession();
    const response = await fetch("/api/website-concierge/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hera-Website-Session": credential.sessionToken,
      },
      body: JSON.stringify({
        sessionId: credential.sessionId,
        message: question,
      }),
    });

    if (!response.ok && !response.headers.get("content-type")?.includes("text/event-stream")) {
      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        localStorage.removeItem(SESSION_KEY);
        session = null;
      }
      throw new Error(payload?.error || "Hera Concierge is temporarily unavailable.");
    }

    await consumeSse(response, (event, payload) => {
      if (event === "status") {
        statusText = payload?.message || statusText;
        typing.bubble.textContent = statusText;
        scrollToLatest();
      }
      if (event === "delta") {
        if (!answerEntry) {
          typing.article.remove();
          answerEntry = messageElement("concierge", "");
        }
        answerEntry.bubble.textContent += payload?.text || "";
        scrollToLatest();
      }
      if (event === "actions") renderDynamicActions(payload);
      if (event === "error") throw new Error(payload?.message || "Hera Concierge is temporarily unavailable.");
    });

    if (!answerEntry?.bubble.textContent.trim()) {
      throw new Error("Hera Concierge did not return a reply. Please try once more.");
    }
  } catch (error) {
    typing.article.remove();
    const entry = messageElement(
      "error",
      error instanceof Error
        ? error.message
        : "I’m having a little difficulty responding just now. Please try once more, or contact the Hera team directly.",
    );
    entry.article.querySelector(".message__label").textContent = "Hera Concierge";
  } finally {
    setBusy(false);
    field.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendQuestion(field.value);
});

field.addEventListener("input", autoresize);
field.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-question]");
  if (button) void sendQuestion(button.dataset.question);
});

contactButton.addEventListener("click", () => {
  contactOptions.hidden = !contactOptions.hidden;
});

document.addEventListener("click", (event) => {
  if (!contactOptions.contains(event.target) && event.target !== contactButton) {
    contactOptions.hidden = true;
  }
});

messageElement(
  "concierge",
  "Welcome to Hera. I can help with your hair, our services and stylists, both ateliers, pricing and booking guidance. What would you like to explore?",
);
void ensureSession().catch(() => {
  statusElement("The private concierge session will reconnect when you send your first message.");
});
