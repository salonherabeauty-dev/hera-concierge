const root = document.querySelector("#reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk repair root was not found.");
}

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const scrollMemory = new Map();
let activeConversationId = null;
let patchScheduled = false;
let noticeTimer = null;

function cookie(name) {
  for (const item of document.cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const method = String(options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Hera-CSRF", cookie("__Host-hera_cc_csrf"));
  }
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.code === "string"
          ? payload.code.replaceAll("_", " ")
          : "The request could not be completed.",
    );
    error.code = typeof payload.code === "string" ? payload.code : "request_failed";
    throw error;
  }
  return payload;
}

function selectedConversationId() {
  const selected = root.querySelector(
    ".fd-conversation--selected[data-conversation-id]",
  );
  return selected instanceof HTMLElement
    ? selected.dataset.conversationId ?? null
    : null;
}

function displayedPhoneEnding() {
  const text = root.querySelector(".fd-client-copy span")?.textContent ?? "";
  return text.match(/([0-9]{4})\s*$/)?.[1] ?? null;
}

function effectiveMessageTime(message) {
  const value = message?.providerTimestamp || message?.createdAt;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function latestMessage(messages) {
  return [...messages].sort((left, right) => {
    const time = effectiveMessageTime(left) - effectiveMessageTime(right);
    if (time !== 0) return time;
    return Date.parse(String(left?.createdAt ?? "")) - Date.parse(String(right?.createdAt ?? ""));
  }).at(-1) ?? null;
}

function showNotice(message, type = "success") {
  let notice = document.querySelector("[data-emergency-fix-notice]");
  if (!(notice instanceof HTMLElement)) {
    notice = document.createElement("div");
    notice.dataset.emergencyFixNotice = "true";
    notice.className = "fd-notice";
    document.body.append(notice);
  }
  notice.className = `fd-notice${type === "error" ? " fd-notice--error" : ""}`;
  notice.textContent = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => notice?.remove(), 6000);
}

function friendlyDraftError(error) {
  const code = error && typeof error === "object" ? error.code : null;
  const messages = {
    customer_service_window_expired:
      "This WhatsApp reply window has closed. Open a fresh client message to create and send an AI reply.",
    human_reply_already_recorded:
      "Hera has already replied after this client message, so a new AI reply was not created.",
    source_message_not_latest:
      "A newer client message has arrived. Refresh the inbox and create the reply for the latest message.",
    message_not_reply_worthy:
      "This reaction or system update does not need a client reply.",
    recipient_mismatch:
      "The displayed client changed before the request completed. Please refresh and try again.",
  };
  return messages[code] || (error instanceof Error ? error.message : "The AI reply could not be created.");
}

function createDraftButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fd-button fd-button--primary fd-emergency-draft-action";
  button.dataset.action = "create-ai-reply";
  button.textContent = "Create AI Reply";
  return button;
}

function ensureDraftAction() {
  if (root.querySelector(".fd-draft")) return;
  const conversationId = selectedConversationId();
  if (!conversationId) return;
  const card = root.querySelector(".fd-status-card");
  if (!(card instanceof HTMLElement)) return;
  const heading = card.querySelector("strong")?.textContent ?? "";
  if (
    !/Human handling is active|No send-ready AI draft|AI reply is being prepared/i.test(
      heading,
    )
  ) {
    return;
  }
  if (card.querySelector('[data-action="create-ai-reply"]')) return;

  let actions = card.querySelector(".fd-status-card__actions");
  if (!(actions instanceof HTMLElement)) {
    actions = document.createElement("div");
    actions.className = "fd-status-card__actions";
    const existingButton = card.querySelector(":scope > button");
    if (existingButton instanceof HTMLElement) actions.append(existingButton);
    card.append(actions);
  }
  actions.prepend(createDraftButton());

  const copy = card.querySelector("div:nth-child(2)");
  if (copy instanceof HTMLElement && !copy.querySelector(".fd-draft-repair-note")) {
    const note = document.createElement("p");
    note.className = "fd-draft-repair-note";
    note.textContent =
      "The AI can still prepare a draft while the human remains the final reviewer and sender.";
    copy.append(note);
  }
}

function correctMisleadingLabels() {
  for (const chip of root.querySelectorAll(".fd-chip")) {
    if (chip.textContent?.trim() === "Follow-up needed") {
      chip.textContent = "Reply window closed";
    }
  }
}

function rememberThreadScroll(thread) {
  const conversationId = selectedConversationId();
  if (!conversationId) return;
  const bottomDistance = Math.max(
    0,
    thread.scrollHeight - thread.clientHeight - thread.scrollTop,
  );
  scrollMemory.set(conversationId, {
    top: thread.scrollTop,
    bottomDistance,
    atBottom: bottomDistance < 72,
  });
  ensureNewestButton(thread, conversationId);
}

function ensureNewestButton(thread, conversationId) {
  const workspace = root.querySelector(".fd-workspace");
  if (!(workspace instanceof HTMLElement)) return;
  const bottomDistance = Math.max(
    0,
    thread.scrollHeight - thread.clientHeight - thread.scrollTop,
  );
  let button = workspace.querySelector("[data-action='scroll-newest']");
  if (bottomDistance < 140) {
    button?.remove();
    return;
  }
  if (button instanceof HTMLElement) return;
  button = document.createElement("button");
  button.type = "button";
  button.className = "fd-thread-scroll-hint";
  button.dataset.action = "scroll-newest";
  button.dataset.conversationId = conversationId;
  button.textContent = "↓ Newest message";
  workspace.append(button);
}

function restoreThreadAfterRender() {
  const conversationId = selectedConversationId();
  const thread = root.querySelector(".fd-thread");
  if (!conversationId || !(thread instanceof HTMLElement)) return;

  const changedConversation = activeConversationId !== conversationId;
  const saved = scrollMemory.get(conversationId);
  activeConversationId = conversationId;

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (!thread.isConnected) return;
        if (changedConversation || !saved || saved.atBottom) {
          thread.scrollTop = thread.scrollHeight;
        } else {
          const maximum = Math.max(0, thread.scrollHeight - thread.clientHeight);
          thread.scrollTop = Math.min(saved.top, maximum);
        }
        rememberThreadScroll(thread);
      }, 0);
    });
  });
}

function applyPatches() {
  patchScheduled = false;
  correctMisleadingLabels();
  ensureDraftAction();
  restoreThreadAfterRender();
}

function schedulePatches() {
  if (patchScheduled) return;
  patchScheduled = true;
  queueMicrotask(applyPatches);
}

root.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.classList.contains("fd-thread")) {
      rememberThreadScroll(target);
    }
  },
  true,
);

root.addEventListener(
  "click",
  async (event) => {
    const actionTarget =
      event.target instanceof Element
        ? event.target.closest("[data-action]")
        : null;
    const action = actionTarget?.getAttribute("data-action");
    if (action === "scroll-newest") {
      event.preventDefault();
      event.stopPropagation();
      const thread = root.querySelector(".fd-thread");
      if (thread instanceof HTMLElement) {
        thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
      }
      return;
    }
    if (action !== "create-ai-reply") return;

    event.preventDefault();
    event.stopPropagation();
    const button = actionTarget;
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;

    const conversationId = selectedConversationId();
    const phoneEnding = displayedPhoneEnding();
    if (!conversationId || !phoneEnding) {
      showNotice("The selected client could not be verified. Refresh the inbox and try again.", "error");
      return;
    }

    button.disabled = true;
    button.textContent = "Creating AI reply…";
    try {
      const detailResult = await request(
        `/api/command-centre/conversation?id=${encodeURIComponent(conversationId)}`,
      );
      const messages = Array.isArray(detailResult?.detail?.messages)
        ? detailResult.detail.messages
        : [];
      const latest = latestMessage(messages);
      if (!latest || latest.direction !== "inbound") {
        const error = new Error(
          "Hera has already sent the latest message, so no new AI reply is needed.",
        );
        error.code = "human_reply_already_recorded";
        throw error;
      }
      const receivedAt = effectiveMessageTime(latest);
      if (!Number.isFinite(receivedAt) || Date.now() - receivedAt >= REPLY_WINDOW_MS) {
        const error = new Error("The WhatsApp reply window has closed.");
        error.code = "customer_service_window_expired";
        throw error;
      }

      const result = await request("/api/command-centre/receptionist-draft", {
        method: "POST",
        body: JSON.stringify({
          conversationId,
          sourceMessageId: latest.id,
          expectedPhoneEnding: phoneEnding,
        }),
      });
      showNotice(
        result.item
          ? "AI reply created. Opening the editable draft now."
          : "The AI reply is being prepared. Refreshing the conversation.",
      );
      window.setTimeout(() => {
        const refresh = root.querySelector('[data-action="refresh"]');
        if (refresh instanceof HTMLButtonElement) refresh.click();
      }, 350);
    } catch (error) {
      showNotice(friendlyDraftError(error), "error");
      button.disabled = false;
      button.textContent = "Create AI Reply";
    }
  },
  true,
);

const observer = new MutationObserver(schedulePatches);
observer.observe(root, { childList: true, subtree: true, characterData: true });
schedulePatches();
