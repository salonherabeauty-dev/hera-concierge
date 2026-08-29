import {
  isInboundHumanHandling,
  matchesInboxSearch,
  needsReplyInInbox,
} from "./receptionist-inbox-policy.js";

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
  lastSelectedConversationId: null,
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
  const selectedId =
    selected instanceof HTMLElement
      ? selected.dataset.conversationId ?? null
      : null;
  if (selectedId) recoveryState.lastSelectedConversationId = selectedId;
  return selectedId ?? recoveryState.lastSelectedConversationId;
}

function displayedPhoneEnding() {
  const text = root.querySelector(".fd-client-copy span")?.textContent ?? "";
  return text.match(/([0-9]{4})\s*$/)?.[1] ?? null;
}

function activeFilter() {
  const active = root.querySelector(".fd-tab--active[data-filter]");
  return active instanceof HTMLElement ? active.dataset.filter ?? null : null;
}

function activeSearch() {
  const input = root.querySelector("[data-search-input]");
  return input instanceof HTMLInputElement ? input.value : "";
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

function cleanText(value) {
  return String(value ?? "")
    .replaceAll("â€™", "’")
    .replaceAll("â€œ", "“")
    .replaceAll("â€", "”")
    .replaceAll("â€“", "–")
    .replaceAll("â€”", "—")
    .replaceAll("Â", "")
    .replaceAll("�", "")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value, maximum = 78) {
  const text = cleanText(value);
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function initials(value) {
  const text = cleanText(value);
  if (!text) return "H";
  return text
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

function singaporeDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatRowTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const difference = Date.now() - date.getTime();
  if (difference >= 0 && difference < 60_000) return "Now";
  if (difference >= 0 && difference < 3_600_000) {
    return `${Math.max(1, Math.floor(difference / 60_000))}m`;
  }
  if (singaporeDay(date) === singaporeDay(new Date())) {
    return new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
  }).format(date);
}

function createChip(label, tone) {
  const chip = document.createElement("span");
  chip.className = `fd-chip fd-chip--${tone} fd-chip--compact`;
  chip.textContent = label;
  return chip;
}

function createRecoveredNeedsReplyRow(conversation) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fd-conversation";
  button.dataset.action = "select-conversation";
  button.dataset.conversationId = String(conversation.id);
  button.dataset.recoveredNeedsReply = "true";
  const selected =
    recoveryState.lastSelectedConversationId === conversation.id;
  if (selected) button.classList.add("fd-conversation--selected");
  button.setAttribute("aria-current", selected ? "true" : "false");

  const avatar = document.createElement("span");
  avatar.className = "fd-avatar";
  avatar.textContent = initials(conversation.clientDisplayName);

  const body = document.createElement("span");
  body.className = "fd-conversation__body";

  const title = document.createElement("span");
  title.className = "fd-conversation__title";
  const name = document.createElement("strong");
  name.textContent = cleanText(conversation.clientDisplayName) ||
    `Client •••• ${String(conversation.phoneEnding ?? "")}`;
  const time = document.createElement("time");
  time.textContent = formatRowTime(conversation.lastMessageAt);
  title.append(name, time);

  const preview = document.createElement("span");
  preview.className = "fd-conversation__preview";
  preview.textContent =
    compact(conversation.lastMessagePreview) || "New WhatsApp message";

  const meta = document.createElement("span");
  meta.className = "fd-conversation__meta";
  meta.append(createChip("Needs reply", "gold"));
  if (isInboundHumanHandling(conversation)) {
    meta.append(createChip("Human handling", "purple"));
  }
  if (conversation.currentRisk === "black") {
    meta.append(createChip("Emergency", "red"));
  } else if (conversation.currentRisk === "red") {
    meta.append(createChip("Urgent", "red"));
  } else if (conversation.currentRisk === "amber") {
    meta.append(createChip("Needs care", "gold"));
  }
  if (Number(conversation.openTaskCount) > 0) {
    const open = document.createElement("span");
    open.className = "fd-meta-label";
    open.textContent = `${Number(conversation.openTaskCount)} open`;
    meta.append(open);
  }

  body.append(title, preview, meta);
  button.append(avatar, body);
  return button;
}

function repairFilterCounts() {
  const conversations = [...recoveryState.conversations.values()];
  const needsCount = conversations.filter(needsReplyInInbox).length;
  const heldCount = conversations.filter(
    (conversation) => conversation?.operatingMode === "management",
  ).length;

  const needsTab = root.querySelector('.fd-tab[data-filter="needs"] strong');
  if (needsTab instanceof HTMLElement) needsTab.textContent = String(needsCount);
  const heldTab = root.querySelector('.fd-tab[data-filter="held"] strong');
  if (heldTab instanceof HTMLElement) heldTab.textContent = String(heldCount);
  const inboxNeedCount = root.querySelector(".fd-inbox-title > span strong");
  if (inboxNeedCount instanceof HTMLElement) {
    inboxNeedCount.textContent = String(needsCount);
  }
}

function repairMissingNeedsReplyRows() {
  const list = root.querySelector("[data-inbox-list]");
  if (!(list instanceof HTMLElement)) return;

  repairFilterCounts();
  const recoveredRows = [...list.querySelectorAll(
    '[data-recovered-needs-reply="true"][data-conversation-id]',
  )].filter((row) => row instanceof HTMLElement);

  if (activeFilter() !== "needs") {
    for (const row of recoveredRows) row.remove();
    return;
  }

  const search = activeSearch();
  const desired = [...recoveryState.conversations.values()]
    .filter(needsReplyInInbox)
    .filter((conversation) => matchesInboxSearch(conversation, search));
  const desiredIds = new Set(desired.map((conversation) => conversation.id));

  const ordinaryIds = new Set(
    [...list.querySelectorAll(
      '.fd-conversation[data-conversation-id]:not([data-recovered-needs-reply="true"])',
    )]
      .filter((row) => row instanceof HTMLElement)
      .map((row) => row.dataset.conversationId)
      .filter(Boolean),
  );

  for (const row of recoveredRows) {
    const id = row.dataset.conversationId;
    if (!id || !desiredIds.has(id) || ordinaryIds.has(id)) row.remove();
  }

  const visibleIds = new Set(
    [...list.querySelectorAll(".fd-conversation[data-conversation-id]")]
      .filter((row) => row instanceof HTMLElement)
      .map((row) => row.dataset.conversationId)
      .filter(Boolean),
  );

  let added = false;
  for (const conversation of desired) {
    if (visibleIds.has(conversation.id)) continue;
    list.append(createRecoveredNeedsReplyRow(conversation));
    visibleIds.add(conversation.id);
    added = true;
  }

  if (added) list.querySelector(".fd-empty-list")?.remove();
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
  if (rows.length === 0) return;

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

  const newestVisibleId = sorted[0]?.dataset.conversationId ?? null;
  if (
    newestVisibleId &&
    newestVisibleId !== recoveryState.newestConversationId &&
    ["needs", "all"].includes(activeFilter() ?? "")
  ) {
    recoveryState.newestConversationId = newestVisibleId;
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
    repairMissingNeedsReplyRows();
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
    repairMissingNeedsReplyRows();
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

root.addEventListener(
  "click",
  (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-action]")
        : null;
    const action = target?.getAttribute("data-action");
    if (action === "select-conversation") {
      recoveryState.lastSelectedConversationId =
        target?.getAttribute("data-conversation-id") || null;
    } else if (action === "back") {
      recoveryState.lastSelectedConversationId = null;
    }
  },
  true,
);

const observer = new MutationObserver(() => {
  scheduleInboxSort(40);
  scheduleAutoDraftCheck(900);
});
observer.observe(root, { childList: true, subtree: true });

void refreshConversationOrder();
scheduleAutoDraftCheck(1_500);

window.setInterval(() => {
  if (document.visibilityState !== "visible") return;
  void refreshConversationOrder();
  scheduleAutoDraftCheck(800);
}, 8_000);
