const root = document.querySelector("#reset-reception-app");
if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk reset root was not found.");
}

const state = {
  conversations: [],
  resetStates: new Map(),
  selectedId: null,
  detail: null,
  filter: "needs",
  search: "",
  draft: "",
  draftDirty: false,
  manualMode: false,
  busy: null,
  notice: null,
  loading: true,
  exactCommit: null,
  resetVersion: null,
  refreshedAt: null,
  expanded: new Set(),
  scrollToBottom: false,
};

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  const method = String(options.method ?? "GET").toUpperCase();
  if (options.body) headers.set("Content-Type", "application/json");
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
    error.status = response.status;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clean(value) {
  return String(value ?? "")
    .replaceAll("â€™", "’")
    .replaceAll("â€œ", "“")
    .replaceAll("â€", "”")
    .replaceAll("â€“", "–")
    .replaceAll("â€”", "—")
    .replaceAll("Â", "")
    .replaceAll("�", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compact(value, maximum = 78) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function initials(value) {
  const text = clean(value);
  if (!text) return "H";
  return text
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function parsedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function singaporeDay(value) {
  const date = parsedDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function rowTime(value) {
  const date = parsedDate(value);
  if (!date) return "";
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

function fullTime(value) {
  const date = parsedDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function dayLabel(value) {
  const date = parsedDate(value);
  if (!date) return "";
  const today = singaporeDay(new Date());
  const day = singaporeDay(date);
  if (day === today) return "Today";
  if (day === singaporeDay(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

function currentConversation() {
  return state.conversations.find((item) => item.id === state.selectedId) ?? null;
}

function resetState(conversationId) {
  return state.resetStates.get(conversationId) ?? null;
}

function primaryStatus(conversation) {
  const reset = resetState(conversation.id);
  if (reset?.turnStatus === "ready" && reset?.candidateStatus === "ready") {
    return { key: "ready", label: "AI draft ready", tone: "green" };
  }
  if (reset?.turnStatus === "processing") {
    return { key: "processing", label: "AI preparing reply", tone: "gold" };
  }
  if (reset?.turnStatus === "failed") {
    return { key: "failed", label: "AI draft failed", tone: "red" };
  }
  if (reset?.candidateStatus === "rejected") {
    return { key: "held", label: "Held for manual reply", tone: "purple" };
  }
  if (conversation.lastMessageDirection === "inbound") {
    const age = Date.now() - Date.parse(conversation.lastMessageAt);
    if (Number.isFinite(age) && age >= REPLY_WINDOW_MS) {
      return { key: "expired", label: "Reply window closed", tone: "red" };
    }
    return { key: "needs", label: "Needs reply", tone: "gold" };
  }
  if (conversation.lastMessageDirection === "outbound") {
    return { key: "waiting", label: "Waiting for client", tone: "blue" };
  }
  return { key: "idle", label: "No recent message", tone: "neutral" };
}

function riskStatus(conversation) {
  if (conversation.currentRisk === "black") return { label: "Emergency", tone: "red" };
  if (conversation.currentRisk === "red") return { label: "Urgent", tone: "red" };
  if (conversation.currentRisk === "amber") return { label: "Needs care", tone: "gold" };
  return null;
}

function isAnsweredToday(conversation) {
  return conversation.lastMessageDirection === "outbound" &&
    singaporeDay(conversation.lastMessageAt) === singaporeDay(new Date());
}

function matchesFilter(conversation) {
  const status = primaryStatus(conversation).key;
  if (state.filter === "all") return true;
  if (state.filter === "needs") {
    return conversation.lastMessageDirection === "inbound" ||
      ["ready", "processing", "failed"].includes(status);
  }
  if (state.filter === "waiting") return status === "waiting";
  if (state.filter === "answered") return isAnsweredToday(conversation);
  if (state.filter === "held") {
    return conversation.operatingMode === "management" || status === "held";
  }
  return true;
}

function visibleConversations() {
  const search = state.search.trim().toLowerCase();
  return state.conversations
    .filter(matchesFilter)
    .filter((conversation) => {
      if (!search) return true;
      return [
        conversation.clientDisplayName,
        conversation.phoneEnding,
        conversation.lastMessagePreview,
      ].some((value) => clean(value).toLowerCase().includes(search));
    })
    .sort((left, right) =>
      Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt),
    );
}

function counts() {
  return {
    needs: state.conversations.filter((conversation) =>
      conversation.lastMessageDirection === "inbound" ||
      ["ready", "processing", "failed"].includes(primaryStatus(conversation).key),
    ).length,
    waiting: state.conversations.filter((conversation) =>
      primaryStatus(conversation).key === "waiting",
    ).length,
    answered: state.conversations.filter(isAnsweredToday).length,
    held: state.conversations.filter((conversation) =>
      conversation.operatingMode === "management" ||
      primaryStatus(conversation).key === "held",
    ).length,
    all: state.conversations.length,
  };
}

function badge(status) {
  return `<span class="rr-badge rr-badge--${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>`;
}

function setNotice(message, type = "success") {
  state.notice = { message, type };
  render();
  window.setTimeout(() => {
    if (state.notice?.message === message) {
      state.notice = null;
      render();
    }
  }, 6000);
}

async function loadResetStates(conversations) {
  const ids = conversations.map((item) => item.id).filter(Boolean);
  const next = new Map();
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const result = await request(
      `/api/command-centre/reset-state?conversationIds=${encodeURIComponent(chunk.join(","))}`,
    );
    state.exactCommit = result.exactCommit ?? state.exactCommit;
    state.resetVersion = result.resetVersion ?? state.resetVersion;
    for (const item of Array.isArray(result.states) ? result.states : []) {
      if (item?.conversationId) next.set(item.conversationId, item);
    }
  }
  state.resetStates = next;
}

async function loadDetail(conversationId, preserveDraft = true) {
  if (!conversationId) {
    state.detail = null;
    return;
  }
  const result = await request(
    `/api/command-centre/conversation?id=${encodeURIComponent(conversationId)}`,
  );
  state.detail = result.detail ?? result;
  const reset = resetState(conversationId);
  if (!preserveDraft || !state.draftDirty) {
    state.draft = reset?.candidateText ?? "";
    state.draftDirty = false;
    state.manualMode = false;
  }
}

async function refreshWorkspace(options = {}) {
  const preserveDraft = options.preserveDraft !== false;
  try {
    const result = await request("/api/command-centre/conversations?limit=300");
    const conversations = Array.isArray(result.conversations)
      ? result.conversations
      : [];
    state.conversations = conversations;
    await loadResetStates(conversations);

    const selectedStillExists = conversations.some((item) => item.id === state.selectedId);
    if (!selectedStillExists) state.selectedId = null;
    if (!state.selectedId) {
      const first = visibleConversations()[0] ?? conversations[0] ?? null;
      state.selectedId = first?.id ?? null;
      state.scrollToBottom = true;
    }
    if (state.selectedId) await loadDetail(state.selectedId, preserveDraft);
    state.loading = false;
    state.refreshedAt = new Date();
    render();
  } catch (error) {
    state.loading = false;
    setNotice(
      error instanceof Error ? error.message : "The Reception Desk could not refresh.",
      "error",
    );
  }
}

function renderInbox() {
  const list = visibleConversations();
  const totals = counts();
  const rows = list.map((conversation) => {
    const status = primaryStatus(conversation);
    const risk = riskStatus(conversation);
    const human = conversation.operatingMode === "management"
      ? { label: "Human handling", tone: "purple" }
      : null;
    return `
      <button type="button" class="rr-row ${conversation.id === state.selectedId ? "rr-row--selected" : ""}" data-action="select" data-id="${escapeHtml(conversation.id)}">
        <span class="rr-avatar">${escapeHtml(initials(conversation.clientDisplayName))}</span>
        <span>
          <span class="rr-row-title">
            <strong>${escapeHtml(clean(conversation.clientDisplayName) || `Client •••• ${conversation.phoneEnding ?? ""}`)}</strong>
            <time>${escapeHtml(rowTime(conversation.lastMessageAt))}</time>
          </span>
          <span class="rr-preview">${escapeHtml(compact(conversation.lastMessagePreview) || "New WhatsApp message")}</span>
          <span class="rr-badges">
            ${badge(status)}
            ${human ? badge(human) : ""}
            ${risk ? badge(risk) : ""}
            ${Number(conversation.openTaskCount) > 0 ? `<span class="rr-badge rr-badge--neutral">${Number(conversation.openTaskCount)} open</span>` : ""}
          </span>
        </span>
      </button>`;
  }).join("");

  return `
    <aside class="rr-inbox">
      <div class="rr-panel-title">
        <p class="rr-eyebrow">Tanglin WhatsApp</p>
        <div><h2>Inbox <span class="rr-totals">${totals.needs} need reply · ${totals.all} total</span></h2></div>
      </div>
      <div class="rr-search">
        <span>⌕</span>
        <input data-search value="${escapeHtml(state.search)}" placeholder="Search client, last 4 digits or message" aria-label="Search inbox">
        ${state.search ? '<button type="button" data-action="clear-search" aria-label="Clear search">×</button>' : ""}
      </div>
      <nav class="rr-tabs" aria-label="Inbox filters">
        ${[
          ["needs", "Needs reply", totals.needs],
          ["waiting", "Waiting", totals.waiting],
          ["answered", "Answered today", totals.answered],
          ["held", "On hold", totals.held],
          ["all", "All conversations", totals.all],
        ].map(([key, label, count]) => `
          <button type="button" class="rr-tab ${state.filter === key ? "rr-tab--active" : ""}" data-action="filter" data-filter="${key}">
            <span>${label}</span><strong>${count}</strong>
          </button>`).join("")}
      </nav>
      <div class="rr-list" data-inbox-list>
        ${rows || '<div class="rr-empty">No conversations match this view.</div>'}
      </div>
    </aside>`;
}

function messageList() {
  const messages = Array.isArray(state.detail?.messages)
    ? state.detail.messages
    : [];
  if (messages.length === 0) {
    return '<div class="rr-empty">No conversation messages are available.</div>';
  }
  let previousDay = "";
  return messages.map((message) => {
    const effectiveAt = message.providerTimestamp || message.createdAt;
    const day = singaporeDay(effectiveAt);
    const separator = day !== previousDay
      ? `<div class="rr-day">${escapeHtml(dayLabel(effectiveAt))}</div>`
      : "";
    previousDay = day;
    const full = clean(message.text || message.textBody || "");
    const id = message.id ?? `${effectiveAt}-${full.slice(0, 20)}`;
    const expanded = state.expanded.has(id);
    const display = full.length > 850 && !expanded
      ? `${full.slice(0, 820)}…`
      : full;
    return `${separator}
      <article class="rr-message ${message.direction === "outbound" ? "rr-message--outbound" : ""}">
        ${escapeHtml(display || `[${message.kind || "message"}]`)}
        ${full.length > 850 && !expanded ? `<div><button class="rr-button" data-action="expand-message" data-id="${escapeHtml(id)}">Show full message</button></div>` : ""}
        <footer>${escapeHtml(fullTime(effectiveAt))}${message.deliveryStatus ? ` · ${escapeHtml(message.deliveryStatus)}` : ""}</footer>
      </article>`;
  }).join("");
}

function composerView(conversation) {
  const reset = resetState(conversation.id);
  const status = primaryStatus(conversation);
  const phoneEnding = conversation.phoneEnding ?? "";
  const withinWindow = conversation.lastMessageDirection === "inbound" &&
    Date.now() - Date.parse(conversation.lastMessageAt) < REPLY_WINDOW_MS;

  if (status.key === "ready" && reset?.candidateId) {
    const edited = state.draft !== (reset.candidateText ?? "");
    return `
      <section class="rr-composer rr-draft">
        <div class="rr-draft-header">
          <strong>Reply to client</strong>
          <span>GPT‑5.6 Sol · ${reset.candidateModelAttempts ?? 1} model call${Number(reset.candidateModelAttempts) === 1 ? "" : "s"}</span>
        </div>
        <textarea data-draft aria-label="Editable AI reply" maxlength="4000">${escapeHtml(state.draft)}</textarea>
        <div class="rr-draft-meta">
          <span>${state.draft.length}/4000${edited ? " · Edited by human" : " · AI draft ready for review"}</span>
          <span>Nothing is sent until a human presses Send to Client.</span>
        </div>
        <div class="rr-actions">
          <button class="rr-button rr-button--danger" data-action="hold" ${state.busy ? "disabled" : ""}>Take Over / Hold</button>
          <button class="rr-button" data-action="regenerate" ${state.busy || !reset.retryAvailable ? "disabled" : ""}>${reset.retryAvailable ? "Regenerate" : "Regeneration used"}</button>
          <button class="rr-button rr-button--primary" data-action="send" ${state.busy || !state.draft.trim() || !withinWindow ? "disabled" : ""}>${state.busy === "send" ? "Sending…" : "Send to Client"}</button>
        </div>
      </section>`;
  }

  if (["collecting", "processing"].includes(reset?.turnStatus)) {
    return `
      <section class="rr-composer">
        <div class="rr-state">
          <div class="rr-state-icon"><span class="rr-spinner"></span></div>
          <div class="rr-state-copy">
            <strong>AI is preparing your requested reply</strong>
            <p>This single draft was started by a human. Nothing will be sent automatically.</p>
          </div>
        </div>
      </section>`;
  }

  if (reset?.turnStatus === "collecting" && reset?.turnId) {
    const readyAt = Date.parse(reset.settleAt || "");
    const ready = Number.isFinite(readyAt) && readyAt <= Date.now();
    return `
      <section class="rr-composer">
        <div class="rr-state">
          <div class="rr-state-icon">AI</div>
          <div class="rr-state-copy">
            <strong>AI assistance is available</strong>
            <p>No AI cost has been incurred for this message. Generate one best-quality draft only when assistance is needed.</p>
          </div>
          <div class="rr-state-actions">
            <button class="rr-button rr-button--primary" data-action="generate" ${state.busy || !ready ? "disabled" : ""}>${state.busy === "generate" ? "Generating…" : ready ? "Generate AI Reply" : "Messages still arriving…"}</button>
          </div>
        </div>
      </section>`;
  }

  if (reset?.turnStatus === "failed") {
    return `
      <section class="rr-composer">
        <div class="rr-state">
          <div class="rr-state-icon">!</div>
          <div class="rr-state-copy">
            <strong>AI could not prepare this reply</strong>
            <p>${escapeHtml(reset.failureMessage || "The drafting request failed visibly. Retry once or write the reply manually.")}</p>
          </div>
          <div class="rr-state-actions">
            <button class="rr-button" data-action="manual" ${state.busy ? "disabled" : ""}>Write manually</button>
            ${reset.retryAvailable
              ? `<button class="rr-button rr-button--primary" data-action="retry" ${state.busy ? "disabled" : ""}>${state.busy === "retry" ? "Retrying…" : "Retry AI Reply"}</button>`
              : '<span class="rr-retry-used">The single AI retry has already been used.</span>'}
          </div>
        </div>
        ${state.manualMode ? `<div class="rr-manual"><textarea data-manual-draft aria-label="Manual reply" maxlength="4000" placeholder="Write the reply here…">${escapeHtml(state.draft)}</textarea><p class="rr-draft-meta">A manual reply must first be saved as a human draft before it can be sent.</p></div>` : ""}
      </section>`;
  }

  if (status.key === "expired") {
    return `
      <section class="rr-composer">
        <div class="rr-state">
          <div class="rr-state-icon">⌛</div>
          <div class="rr-state-copy"><strong>WhatsApp reply window closed</strong><p>The conversation remains visible, but a free-form reply cannot be sent after 24 hours.</p></div>
        </div>
      </section>`;
  }

  if (conversation.lastMessageDirection === "outbound") {
    return `
      <section class="rr-composer">
        <div class="rr-state">
          <div class="rr-state-icon">✓</div>
          <div class="rr-state-copy"><strong>Waiting for the client</strong><p>Hera has already sent the latest message. If the client replies, Reception may request AI assistance manually.</p></div>
        </div>
      </section>`;
  }

  return `
    <section class="rr-composer">
      <div class="rr-state">
        <div class="rr-state-icon">i</div>
        <div class="rr-state-copy">
          <strong>No AI draft exists for this older message</strong>
          <p>AI generation is manual only. This historical conversation has not been converted into a new client turn.</p>
        </div>
      </div>
    </section>`;
}

function renderMain() {
  const conversation = currentConversation();
  if (!conversation) {
    return '<main class="rr-main"><div class="rr-empty">Choose a client from the inbox.</div></main>';
  }
  const status = primaryStatus(conversation);
  const risk = riskStatus(conversation);
  const human = conversation.operatingMode === "management"
    ? { label: "Human handling", tone: "purple" }
    : null;
  return `
    <main class="rr-main">
      <header class="rr-clientbar">
        <div class="rr-client">
          <button type="button" class="rr-back" data-action="back" aria-label="Back to inbox">‹</button>
          <span class="rr-avatar">${escapeHtml(initials(conversation.clientDisplayName))}</span>
          <div><h2>${escapeHtml(clean(conversation.clientDisplayName) || "Client")}</h2><p>WhatsApp ending ${escapeHtml(conversation.phoneEnding || "")}</p></div>
        </div>
        <div class="rr-client-status">${badge(status)}${human ? badge(human) : ""}${risk ? badge(risk) : ""}</div>
      </header>
      <section class="rr-thread" data-thread>${messageList()}</section>
      ${composerView(conversation)}
    </main>`;
}

function renderContext() {
  const conversation = currentConversation();
  const reset = conversation ? resetState(conversation.id) : null;
  return `
    <aside class="rr-context">
      <p class="rr-eyebrow">Useful context</p>
      <h2>Client overview</h2>
      <section class="rr-context-section">
        <h3>Channel</h3>
        <div class="rr-context-card"><strong>Tanglin Mall WhatsApp</strong><p>The outlet is already known. Do not ask the client which outlet or route the reply to Sentosa.</p></div>
      </section>
      <section class="rr-context-section">
        <h3>Draft status</h3>
        <div class="rr-context-card">
          <strong>${escapeHtml(reset?.turnStatus || "No reset turn")}</strong>
          <p>${reset?.turnVersion ? `Client turn version ${reset.turnVersion}. ` : ""}Delivery control: human only.</p>
          ${reset?.failureCode ? `<p>Failure code: ${escapeHtml(reset.failureCode)}</p>` : ""}
        </div>
      </section>
      <section class="rr-context-section">
        <h3>Front desk</h3>
        <div class="rr-context-card"><strong>${Number(conversation?.openTaskCount || 0)} open item${Number(conversation?.openTaskCount || 0) === 1 ? "" : "s"}</strong><p>Live availability, appointment changes and cancellations still require Timely verification.</p></div>
      </section>
      <p class="rr-commit">Reset: ${escapeHtml(state.resetVersion || "loading")}<br>Commit: ${escapeHtml(state.exactCommit || "loading")}</p>
    </aside>`;
}

function render() {
  if (state.loading) {
    root.innerHTML = '<div class="rr-loading"><div><div class="rr-spinner"></div><strong>Opening Hera Reception Desk</strong><p>Loading the Tanglin WhatsApp inbox and reset-v3 draft states.</p></div></div>';
    return;
  }
  const refreshed = state.refreshedAt
    ? fullTime(state.refreshedAt)
    : "—";
  root.innerHTML = `
    <div class="rr-shell" data-mobile-view="${state.selectedId ? "conversation" : "inbox"}">
      <header class="rr-topbar">
        <div class="rr-brand"><span class="rr-mark">H</span><div><h1>Hera Reception Desk</h1><p>AI-assisted client service · human-approved delivery</p></div></div>
        <div class="rr-channel"><span class="rr-dot"></span><div><strong>Tanglin WhatsApp</strong><p>Updated ${escapeHtml(refreshed)}</p></div><button class="rr-icon-button" data-action="refresh" aria-label="Refresh">↻</button><span class="rr-version">${escapeHtml((state.exactCommit || "").slice(0, 8))}</span></div>
      </header>
      <div class="rr-layout">${renderInbox()}${renderMain()}${renderContext()}</div>
      ${state.notice ? `<div class="rr-notice ${state.notice.type === "error" ? "rr-notice--error" : ""}">${escapeHtml(state.notice.message)}</div>` : ""}
    </div>`;

  if (state.scrollToBottom) {
    const thread = root.querySelector("[data-thread]");
    if (thread instanceof HTMLElement) thread.scrollTop = thread.scrollHeight;
    state.scrollToBottom = false;
  }
}

async function selectConversation(id) {
  state.selectedId = id;
  state.detail = null;
  state.draft = "";
  state.draftDirty = false;
  state.manualMode = false;
  state.scrollToBottom = true;
  render();
  try {
    await loadDetail(id, false);
    render();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The conversation could not be opened.", "error");
  }
}

async function retryDraft() {
  const conversation = currentConversation();
  const reset = conversation ? resetState(conversation.id) : null;
  if (!reset?.turnId) return;
  if (!reset.retryAvailable) {
    setNotice("The single AI retry has already been used. Please write the reply manually.", "error");
    return;
  }
  if (
    reset.turnStatus === "ready" &&
    !window.confirm("Regenerating makes one additional paid AI request. Continue?")
  ) return;
  state.busy = "retry";
  render();
  try {
    await request("/api/command-centre/reset-retry", {
      method: "POST",
      body: JSON.stringify({ turnId: reset.turnId }),
    });
    state.draft = "";
    state.draftDirty = false;
    state.manualMode = false;
    setNotice("The AI is preparing a new reply automatically.");
    await refreshWorkspace({ preserveDraft: false });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The AI reply could not be retried.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

async function generateDraft() {
  const conversation = currentConversation();
  const reset = conversation ? resetState(conversation.id) : null;
  if (!reset?.turnId || reset.turnStatus !== "collecting") return;
  state.busy = "generate";
  render();
  try {
    await request("/api/command-centre/reset-generate", {
      method: "POST",
      body: JSON.stringify({ turnId: reset.turnId }),
    });
    setNotice("One best-quality AI reply is now being prepared for human review.");
    await refreshWorkspace({ preserveDraft: false });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The AI reply could not be generated.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

async function holdDraft() {
  const conversation = currentConversation();
  const reset = conversation ? resetState(conversation.id) : null;
  if (!reset?.candidateId || !reset.candidateHash) return;
  state.busy = "hold";
  render();
  try {
    await request("/api/command-centre/reset-message", {
      method: "POST",
      body: JSON.stringify({
        action: "hold",
        candidateId: reset.candidateId,
        expectedCandidateHash: reset.candidateHash,
      }),
    });
    setNotice("AI draft held. Reception may take over manually.");
    await refreshWorkspace({ preserveDraft: false });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The draft could not be held.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

async function sendDraft() {
  const conversation = currentConversation();
  const reset = conversation ? resetState(conversation.id) : null;
  if (
    !conversation ||
    !reset?.candidateId ||
    !reset.turnId ||
    !reset.turnVersion ||
    !reset.candidateHash ||
    !state.draft.trim()
  ) return;
  state.busy = "send";
  render();
  try {
    const result = await request("/api/command-centre/reset-message", {
      method: "POST",
      body: JSON.stringify({
        action: "send",
        candidateId: reset.candidateId,
        turnId: reset.turnId,
        turnVersion: reset.turnVersion,
        expectedCandidateHash: reset.candidateHash,
        expectedPhoneEnding: conversation.phoneEnding,
        messageText: state.draft.trim(),
      }),
    });
    if (result.state !== "sent") throw new Error("The message was not confirmed as sent.");
    setNotice("Message sent from Tanglin WhatsApp.");
    state.draftDirty = false;
    await refreshWorkspace({ preserveDraft: false });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The message could not be sent.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest("[data-action]")
    : null;
  const action = target?.getAttribute("data-action");
  if (!action) return;
  if (action === "select") {
    void selectConversation(target.getAttribute("data-id"));
  } else if (action === "filter") {
    state.filter = target.getAttribute("data-filter") || "needs";
    const first = visibleConversations()[0] ?? null;
    if (first && !visibleConversations().some((item) => item.id === state.selectedId)) {
      state.selectedId = first.id;
      state.detail = null;
      void loadDetail(first.id, false).then(render).catch(() => render());
    } else {
      render();
    }
  } else if (action === "clear-search") {
    state.search = "";
    render();
  } else if (action === "refresh") {
    void refreshWorkspace();
  } else if (action === "back") {
    state.selectedId = null;
    render();
  } else if (action === "expand-message") {
    state.expanded.add(target.getAttribute("data-id"));
    render();
  } else if (action === "generate") {
    void generateDraft();
  } else if (action === "retry" || action === "regenerate") {
    void retryDraft();
  } else if (action === "hold") {
    void holdDraft();
  } else if (action === "send") {
    void sendDraft();
  } else if (action === "manual") {
    state.manualMode = true;
    state.draft = "";
    state.draftDirty = true;
    render();
  }
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches("[data-search]")) {
    state.search = target.value;
    render();
    const input = root.querySelector("[data-search]");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (target instanceof HTMLTextAreaElement && target.matches("[data-draft], [data-manual-draft]")) {
    state.draft = target.value;
    state.draftDirty = true;
  }
});

void refreshWorkspace({ preserveDraft: false });
window.setInterval(() => {
  if (document.visibilityState === "visible" && !state.busy) {
    void refreshWorkspace({ preserveDraft: true });
  }
}, 8_000);
