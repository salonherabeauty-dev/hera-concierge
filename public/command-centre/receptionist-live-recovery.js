const root = document.querySelector("#reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk live recovery root was not found.");
}

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_DRAFT_DELAY_MS = 5_000;
const AUTO_DRAFT_COOLDOWN_MS = 45_000;
const MAX_AUTO_DRAFT_ATTEMPTS = 3;

const recoveryState = {
  conversations: new Map(),
  newestConversationId: null,
  inFlightSourceIds: new Set(),
  attempts: new Map(),
  sortScheduled: false,
  draftScheduled: false,
  pollingTimers: new Set(),
};

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

function activeFilter() {
  const active = root.querySelector(".fd-tab--active[data-filter]");
  return active instanceof HTMLElement ? active.dataset.filter ?? null : null;
}

function effectiveMessageTime(message) {
  const value = message?.providerTimestamp || message?.createdAt;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function latestMessage(messages) {
  return [...messages].sort((left, right) => {
    const primary = effectiveMessageTime(left) - effectiveMessageTime(right);
    if (primary !== 0) return primary;
    return Date.parse(String(left?.createdAt ?? "")) -
      Date.parse(String(right?.createdAt ?? ""));
  }).at(-1) ?? null;
}

function latestJobForSource(jobs, sourceMessageId) {
  return jobs
    .filter((job) => job?.sourceMessageId === sourceMessageId)
    .sort(
      (left, right) =>
        Date.parse(String(right?.createdAt ?? "")) -
        Date.parse(String(left?.createdAt ?? "")),
    )[0] ?? null;
}

function usableCandidateForSource(candidates, sourceMessageId) {
  return candidates.find(
    (candidate) =>
      candidate?.sourceMessageId === sourceMessageId &&
      !candidate?.providerMessageId &&
      ["pending", "shadowed", "processing"].includes(
        String(candidate?.status ?? ""),
      ),
  ) ?? null;
}

function showNotice(message, type = "success") {
  let notice = document.querySelector("[data-live-recovery-notice]");
  if (!(notice instanceof HTMLElement)) {
    notice = document.createElement("div");
    notice.dataset.liveRecoveryNotice = "true";
    document.body.append(notice);
  }
  notice.className = `fd-notice${type === "error" ? " fd-notice--error" : ""}`;
  notice.textContent = message;
  window.setTimeout(() => notice?.remove(), 6500);
}

function setDraftActionBusy(busy) {
  const button = root.querySelector('[data-action="create-ai-reply"]');
  if (!(button instanceof HTMLButtonElement)) return;
  button.disabled = busy;
  button.textContent = busy ? "AI is preparing…" : "Create AI Reply";
}

function triggerWorkspaceRefresh() {
  const refresh = root.querySelector('[data-action="refresh"]');
  if (refresh instanceof HTMLButtonElement && !refresh.disabled) {
    refresh.click();
  }
}

function clearPollingTimers() {
  for (const timer of recoveryState.pollingTimers) {
    window.clearTimeout(timer);
  }
  recoveryState.pollingTimers.clear();
}

function scheduleDraftPolling() {
  clearPollingTimers();
  for (const delay of [1_000, 4_000, 9_000, 16_000, 28_000]) {
    const timer = window.setTimeout(() => {
      recoveryState.pollingTimers.delete(timer);
      triggerWorkspaceRefresh();
      scheduleAutoDraftCheck(700);
    }, delay);
    recoveryState.pollingTimers.add(timer);
  }
}

function sortedConversationIds() {
  return [...recoveryState.conversations.values()]
    .sort(
      (left, right) =>
        Date.parse(String(right.lastMessageAt ?? "")) -
        Date.parse(String(left.lastMessageAt ?? "")),
    )
    .map((conversation) => conversation.id);
}

function sortVisibleInbox() {
  const list = root.querySelector("[data-inbox-list]");
  if (!(list instanceof HTMLElement)) return;
  const rows = [...list.querySelectorAll(
    ".fd-conversation[data-conversation-id]",
  )].filter((row) => row instanceof HTMLElement);
  if (rows.length < 2) return;

  const rank = new Map(
    sortedConversationIds().map((id, index) => [id, index]),
  );
  const sorted = [...rows].sort((left, right) => {
    const leftRank = rank.get(left.dataset.conversationId ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.dataset.conversationId ?? "") ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
  const alreadySorted = rows.every((row, index) => row === sorted[index]);
  if (!alreadySorted) {
    const fragment = document.createDocumentFragment();
    for (const row of sorted) fragment.append(row);
    list.append(fragment);
  }

  const newestId = sortedConversationIds()[0] ?? null;
  if (
    newestId &&
    newestId !== recoveryState.newestConversationId &&
    ["needs", "all"].includes(activeFilter() ?? "")
  ) {
    recoveryState.newestConversationId = newestId;
    list.scrollTop = 0;
  }
}

async function refreshConversationOrder() {
  try {
    const result = await request("/api/command-centre/conversations?limit=300");
    const conversations = Array.isArray(result.conversations)
      ? result.conversations
      : [];
    recoveryState.conversations = new Map(
      conversations
        .filter((conversation) => conversation?.id)
        .map((conversation) => [conversation.id, conversation]),
    );
    sortVisibleInbox();
  } catch {
    // The main workspace already provides a visible error if the inbox cannot load.
  }
}

function scheduleInboxSort(delay = 0) {
  if (recoveryState.sortScheduled) return;
  recoveryState.sortScheduled = true;
  window.setTimeout(() => {
    recoveryState.sortScheduled = false;
    sortVisibleInbox();
  }, delay);
}

function allowedAutoDraftStatus(job) {
  if (!job) return true;
  const status = String(job.status ?? "");
  if (status === "retry") return true;
  if (status !== "pending") return false;
  const createdAt = Date.parse(String(job.createdAt ?? ""));
  return !Number.isFinite(createdAt) || Date.now() - createdAt >= AUTO_DRAFT_DELAY_MS;
}

function canAttemptSource(sourceMessageId) {
  const current = recoveryState.attempts.get(sourceMessageId);
  if (!current) return true;
  if (current.count >= MAX_AUTO_DRAFT_ATTEMPTS) return false;
  return Date.now() - current.lastAttemptAt >= AUTO_DRAFT_COOLDOWN_MS;
}

function recordAttempt(sourceMessageId) {
  const current = recoveryState.attempts.get(sourceMessageId) ?? {
    count: 0,
    lastAttemptAt: 0,
  };
  recoveryState.attempts.set(sourceMessageId, {
    count: current.count + 1,
    lastAttemptAt: Date.now(),
  });
}

async function maybeRecoverSelectedDraft() {
  if (root.querySelector(".fd-draft")) return;
  const conversationId = selectedConversationId();
  const phoneEnding = displayedPhoneEnding();
  if (!conversationId || !phoneEnding) return;

  const heading = root.querySelector(".fd-status-card strong")?.textContent ?? "";
  if (
    !/AI reply is being prepared|No send-ready AI draft|Human handling is active/i.test(
      heading,
    )
  ) {
    return;
  }

  let detail;
  try {
    detail = await request(
      `/api/command-centre/conversation?id=${encodeURIComponent(conversationId)}`,
    );
  } catch {
    return;
  }

  const messages = Array.isArray(detail?.detail?.messages)
    ? detail.detail.messages
    : [];
  const latest = latestMessage(messages);
  if (!latest || latest.direction !== "inbound") return;

  const receivedAt = effectiveMessageTime(latest);
  if (
    !Number.isFinite(receivedAt) ||
    Date.now() - receivedAt >= REPLY_WINDOW_MS
  ) {
    return;
  }

  const candidates = Array.isArray(detail?.detail?.candidates)
    ? detail.detail.candidates
    : [];
  if (usableCandidateForSource(candidates, latest.id)) {
    triggerWorkspaceRefresh();
    return;
  }

  const jobs = Array.isArray(detail?.detail?.jobs) ? detail.detail.jobs : [];
  const job = latestJobForSource(jobs, latest.id);
  if (!allowedAutoDraftStatus(job)) return;
  if (
    recoveryState.inFlightSourceIds.has(latest.id) ||
    !canAttemptSource(latest.id)
  ) {
    return;
  }

  recoveryState.inFlightSourceIds.add(latest.id);
  recordAttempt(latest.id);
  setDraftActionBusy(true);

  try {
    const result = await request("/api/command-centre/receptionist-draft", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        sourceMessageId: latest.id,
        expectedPhoneEnding: phoneEnding,
      }),
    });
    if (result.item) {
      showNotice("AI reply ready. Opening the editable draft now.");
    }
    scheduleDraftPolling();
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null;
    if (code === "human_reply_already_recorded") {
      triggerWorkspaceRefresh();
    } else if (code === "source_message_not_latest") {
      showNotice("A newer client message arrived. Refreshing the conversation.");
      triggerWorkspaceRefresh();
    } else {
      showNotice(
        error instanceof Error
          ? error.message
          : "The AI reply could not be prepared.",
        "error",
      );
    }
  } finally {
    recoveryState.inFlightSourceIds.delete(latest.id);
    setDraftActionBusy(false);
  }
}

function scheduleAutoDraftCheck(delay = 1_200) {
  if (recoveryState.draftScheduled) return;
  recoveryState.draftScheduled = true;
  window.setTimeout(() => {
    recoveryState.draftScheduled = false;
    void maybeRecoverSelectedDraft();
  }, delay);
}

const observer = new MutationObserver(() => {
  scheduleInboxSort(60);
  scheduleAutoDraftCheck(900);
});
observer.observe(root, { childList: true, subtree: true });

void refreshConversationOrder();
scheduleAutoDraftCheck(1_500);

window.setInterval(() => {
  if (document.visibilityState !== "visible") return;
  void refreshConversationOrder();
  scheduleAutoDraftCheck(800);
}, 12_000);
