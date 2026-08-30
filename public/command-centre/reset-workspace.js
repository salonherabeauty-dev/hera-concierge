const root = document.querySelector("#reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk root was not found.");
}

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 5_000;
const FILTERS = ["needs", "waiting", "answered", "held", "all"];

const state = {
  authKnown: false,
  staff: null,
  csrfToken: "",
  conversations: [],
  deployment: null,
  selectedConversationId: null,
  detail: null,
  resetState: null,
  filter: "needs",
  search: "",
  loadingInbox: false,
  loadingConversation: false,
  busy: null,
  notice: null,
  draftText: "",
  loadedDraftId: null,
  draftDirty: false,
  manualMode: false,
  detailsOpen: false,
  expandedMessages: new Set(),
  threadScrollTop: 0,
  threadNearBottom: true,
  pollTimer: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function icon(name, size = 20) {
  const paths = {
    search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.8-3.8"></path>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path>',
    back: '<path d="m15 18-6-6 6-6"></path>',
    info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
    close: '<path d="m6 6 12 12M18 6 6 18"></path>',
    send: '<path d="m3 11 18-8-8 18-2-8-8-2Z"></path><path d="m11 13 10-10"></path>',
    sparkle: '<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"></path>',
    hold: '<rect x="7" y="5" width="3" height="14" rx="1"></rect><rect x="14" y="5" width="3" height="14" rx="1"></rect>',
    logout: '<path d="M10 5H5v14h5"></path><path d="m14 8 4 4-4 4M18 12H9"></path>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.info}</svg>`;
}

function requestHeaders(body) {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (state.csrfToken) headers.set("X-Hera-CSRF", state.csrfToken);
  return headers;
}

async function request(path, options = {}) {
  const body = options.body === undefined
    ? undefined
    : typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
  const response = await fetch(path, {
    ...options,
    body,
    headers: requestHeaders(body),
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

function formatTime(value) {
  const date = parsedDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDay(value) {
  const date = parsedDate(value);
  if (!date) return "";
  const today = singaporeDay(new Date());
  if (singaporeDay(date) === today) return "Today";
  if (singaporeDay(date) === singaporeDay(new Date(Date.now() - 86_400_000))) {
    return "Yesterday";
  }
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

function formatRowTime(value) {
  const date = parsedDate(value);
  if (!date) return "";
  const difference = Date.now() - date.getTime();
  if (difference >= 0 && difference < 60_000) return "Now";
  if (difference >= 0 && difference < 3_600_000) {
    return `${Math.max(1, Math.floor(difference / 60_000))}m`;
  }
  if (singaporeDay(date) === singaporeDay(new Date())) return formatTime(date);
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
  }).format(date);
}

function formatDateTime(value) {
  const date = parsedDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function initials(name) {
  const value = cleanText(name);
  if (!value) return "H";
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function compact(value, maximum = 92) {
  const text = cleanText(value).replace(/\s+/g, " ");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function currentItem() {
  return state.conversations.find(
    (item) => item.id === state.selectedConversationId,
  ) ?? null;
}

function currentReset() {
  return state.resetState ?? currentItem()?.reset ?? null;
}

function draftStatus(item) {
  const draft = item?.reset?.draft ?? null;
  const turn = item?.reset?.turn ?? null;
  if (draft?.status === "ready") return "ready";
  if (draft?.status === "held") return "held";
  if (draft?.status === "failed" || turn?.status === "failed") return "failed";
  if (["pending", "processing"].includes(draft?.status) ||
      ["collecting", "queued", "processing"].includes(turn?.status)) {
    return "preparing";
  }
  if (draft?.status === "sent") return "sent";
  if (item?.lastMessageDirection === "inbound") return "historical";
  if (item?.lastMessageDirection === "outbound") return "waiting";
  return "idle";
}

function statusPresentation(item) {
  const status = draftStatus(item);
  if (status === "ready") return { label: "AI draft ready", tone: "green" };
  if (status === "preparing") return { label: "AI preparing", tone: "gold" };
  if (status === "failed") return { label: "AI draft failed", tone: "red" };
  if (status === "held") return { label: "On hold", tone: "purple" };
  if (status === "sent") return { label: "Sent", tone: "blue" };
  if (status === "waiting") return { label: "Waiting for client", tone: "blue" };
  if (status === "historical") return { label: "Needs manual reply", tone: "gold" };
  return { label: "No action", tone: "neutral" };
}

function riskPresentation(risk) {
  if (risk === "black") return { label: "Emergency", tone: "red" };
  if (risk === "red") return { label: "Urgent", tone: "red" };
  if (risk === "amber") return { label: "Needs care", tone: "gold" };
  return null;
}

function replyWindowOpen(item) {
  if (!item || item.lastMessageDirection !== "inbound") return false;
  const date = parsedDate(item.lastMessageAt);
  return Boolean(date && Date.now() - date.getTime() < REPLY_WINDOW_MS);
}

function isAnsweredToday(item) {
  return item?.lastMessageDirection === "outbound" &&
    singaporeDay(item.lastMessageAt) === singaporeDay(new Date());
}

function filterCounts() {
  const counts = { needs: 0, waiting: 0, answered: 0, held: 0, all: state.conversations.length };
  for (const item of state.conversations) {
    const status = draftStatus(item);
    if (item.lastMessageDirection === "inbound" && status !== "sent") counts.needs += 1;
    if (item.lastMessageDirection === "outbound" || status === "sent") counts.waiting += 1;
    if (isAnsweredToday(item) || status === "sent") counts.answered += 1;
    if (item.operatingMode === "management" || status === "held") counts.held += 1;
  }
  return counts;
}

function visibleConversations() {
  const search = state.search.trim().toLowerCase();
  return state.conversations
    .filter((item) => {
      if (state.filter === "needs" && item.lastMessageDirection !== "inbound") return false;
      if (state.filter === "waiting" && item.lastMessageDirection !== "outbound" && draftStatus(item) !== "sent") return false;
      if (state.filter === "answered" && !isAnsweredToday(item) && draftStatus(item) !== "sent") return false;
      if (state.filter === "held" && item.operatingMode !== "management" && draftStatus(item) !== "held") return false;
      if (!search) return true;
      return [item.clientDisplayName, item.phoneEnding, item.lastMessagePreview]
        .some((value) => cleanText(value).toLowerCase().includes(search));
    })
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt));
}

function chip(label, tone) {
  return `<span class="reset-chip reset-chip--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function captureThreadPosition() {
  const thread = root.querySelector("[data-thread]");
  if (!(thread instanceof HTMLElement)) return;
  state.threadScrollTop = thread.scrollTop;
  state.threadNearBottom =
    thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
}

function restoreThreadPosition(forceBottom = false) {
  requestAnimationFrame(() => {
    const thread = root.querySelector("[data-thread]");
    if (!(thread instanceof HTMLElement)) return;
    if (forceBottom || state.threadNearBottom) {
      thread.scrollTop = thread.scrollHeight;
    } else {
      thread.scrollTop = state.threadScrollTop;
    }
  });
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

function loginView(error = "") {
  return `
    <main class="reset-login">
      <section class="reset-card">
        <div class="reset-brand-mark">H</div>
        <p class="reset-eyebrow">Hera Hair Beauty</p>
        <h1>Reception Desk</h1>
        <p>Private Tanglin Mall WhatsApp workspace. Every AI reply remains human-reviewed before delivery.</p>
        <form class="reset-form" data-login-form>
          <div class="reset-field">
            <label for="reset-email">Email</label>
            <input id="reset-email" name="email" type="email" autocomplete="username" required>
          </div>
          <div class="reset-field">
            <label for="reset-password">Password</label>
            <input id="reset-password" name="password" type="password" autocomplete="current-password" minlength="12" required>
          </div>
          <button class="reset-primary" type="submit" ${state.busy === "login" ? "disabled" : ""}>
            ${state.busy === "login" ? "Signing in…" : "Sign in"}
          </button>
          ${error ? `<div class="reset-error-inline">${escapeHtml(error)}</div>` : ""}
        </form>
      </section>
    </main>`;
}

function loadingView() {
  return `
    <main class="reset-loading">
      <section class="reset-card">
        <div class="reset-brand-mark">H</div>
        <p class="reset-eyebrow">Tanglin Mall WhatsApp</p>
        <h1>Opening Reception Desk</h1>
        <p>Loading the complete inbox and current human-reviewed AI draft states.</p>
      </section>
    </main>`;
}

function rowView(item) {
  const status = statusPresentation(item);
  const risk = riskPresentation(item.currentRisk);
  const selected = item.id === state.selectedConversationId;
  return `
    <button class="reset-conversation-row ${selected ? "reset-conversation-row--selected" : ""}"
      type="button" data-action="select" data-conversation-id="${escapeHtml(item.id)}"
      aria-current="${selected ? "true" : "false"}">
      <span class="reset-avatar">${escapeHtml(initials(item.clientDisplayName))}</span>
      <span class="reset-row__content">
        <span class="reset-row__top">
          <strong>${escapeHtml(cleanText(item.clientDisplayName))}</strong>
          <time>${escapeHtml(formatRowTime(item.lastMessageAt))}</time>
        </span>
        <span class="reset-row__preview">${escapeHtml(compact(item.lastMessagePreview || "WhatsApp message"))}</span>
        <span class="reset-row__meta">
          ${chip(status.label, status.tone)}
          ${item.operatingMode === "management" ? chip("Human handling", "purple") : ""}
          ${risk ? chip(risk.label, risk.tone) : ""}
        </span>
      </span>
    </button>`;
}

function inboxView() {
  const counts = filterCounts();
  const items = visibleConversations();
  const labels = {
    needs: "Needs reply",
    waiting: "Waiting",
    answered: "Answered",
    held: "On hold",
    all: "All",
  };
  return `
    <aside class="reset-inbox" aria-label="Tanglin WhatsApp inbox">
      <div class="reset-inbox__heading">
        <h1>Inbox</h1>
        <span>${counts.needs} need reply · ${counts.all} total</span>
      </div>
      <label class="reset-search">
        ${icon("search", 18)}
        <input type="search" data-search value="${escapeHtml(state.search)}" placeholder="Search name, last 4 digits or message" aria-label="Search conversations">
      </label>
      <nav class="reset-filters" aria-label="Inbox filters">
        ${FILTERS.map((filter) => `
          <button type="button" class="reset-filter ${state.filter === filter ? "reset-filter--active" : ""}"
            data-action="filter" data-filter="${filter}">
            <strong>${counts[filter]}</strong>${labels[filter]}
          </button>`).join("")}
      </nav>
      <div class="reset-conversation-list" data-inbox-list>
        ${items.length ? items.map(rowView).join("") : `<div class="reset-empty-list">No conversations match this view.</div>`}
      </div>
    </aside>`;
}

function messageView(message) {
  const full = cleanText(message.text || `[${message.kind || "WhatsApp message"}]`);
  const expanded = state.expandedMessages.has(message.id);
  const long = full.length > 900;
  const shown = long && !expanded ? `${full.slice(0, 900)}…` : full;
  const direction = message.direction === "outbound" ? "outbound" : "inbound";
  return `
    <div class="reset-message-group reset-message-group--${direction}">
      <div class="reset-message reset-message--${direction}">
        ${escapeHtml(shown)}
        ${long ? `<button type="button" class="reset-show-message" data-action="expand-message" data-message-id="${escapeHtml(message.id)}">${expanded ? "Show less" : "Show full message"}</button>` : ""}
      </div>
      <span class="reset-message__time">${escapeHtml(formatDay(message.providerTimestamp || message.createdAt))} · ${escapeHtml(formatTime(message.providerTimestamp || message.createdAt))}${direction === "outbound" && message.deliveryStatus ? ` · ${escapeHtml(message.deliveryStatus)}` : ""}</span>
    </div>`;
}

function failureComposer(reset) {
  const draft = reset?.draft;
  const turn = reset?.turn;
  const reason = cleanText(draft?.failureMessage || "The AI could not prepare this reply.");
  if (state.manualMode) {
    return `
      <section class="reset-manual">
        <div class="reset-state-card__heading">
          <strong>Write the reply manually</strong>
          <span>The exact text saved here becomes the editable candidate.</span>
        </div>
        <textarea data-composer placeholder="Write a professional reply…">${escapeHtml(state.draftText)}</textarea>
        <div class="reset-manual__footer">
          <button type="button" class="reset-secondary" data-action="cancel-manual">Cancel</button>
          <button type="button" class="reset-primary" data-action="save-manual" ${state.busy ? "disabled" : ""}>Save Manual Reply</button>
        </div>
      </section>`;
  }
  return `
    <section class="reset-failure">
      <strong>AI could not prepare this reply</strong>
      <p>${escapeHtml(reason)}</p>
      <div class="reset-failure__actions">
        <button type="button" class="reset-primary" data-action="regenerate" ${state.busy || !turn ? "disabled" : ""}>Retry AI Reply</button>
        <button type="button" class="reset-secondary" data-action="manual" ${state.busy || !turn ? "disabled" : ""}>Write Manually</button>
      </div>
    </section>`;
}

function readyComposer(item, reset) {
  const draft = reset.draft;
  const held = draft.status === "held";
  const expired = !replyWindowOpen(item);
  const edited = state.loadedDraftId === draft.id && state.draftText.trim() !== cleanText(draft.candidateText).trim();
  return `
    <section class="reset-composer">
      <div class="reset-state-card__heading">
        <strong>${draft.origin === "human_manual" ? "Human reply" : "AI draft ready"}</strong>
        <span>${draft.modelCalls ? `${draft.modelCalls} model call${draft.modelCalls === 1 ? "" : "s"}` : "Human-written"}${draft.rewriteUsed ? " · one rewrite" : ""}</span>
      </div>
      <textarea data-composer aria-label="Editable client reply">${escapeHtml(state.draftText)}</textarea>
      <div class="reset-composer__footer">
        <div>
          <div class="reset-composer__secondary">
            <button type="button" class="reset-secondary" data-action="regenerate" ${state.busy || !reset.turn ? "disabled" : ""}>${icon("sparkle", 16)} Regenerate</button>
            <button type="button" class="reset-secondary" data-action="takeover" ${state.busy || item.operatingMode === "management" ? "disabled" : ""}>${icon("hold", 16)} Take Over / Hold</button>
          </div>
          <div class="reset-draft-note">${held ? "This draft is held. Regenerate or write a manual reply before sending." : edited ? "Edited by human — the exact text above will be sent." : "Nothing is sent until an authorised human presses Send to Client."}</div>
        </div>
        <button type="button" class="reset-primary reset-send" data-action="send"
          ${state.busy || held || expired || !state.draftText.trim() ? "disabled" : ""}>
          ${icon("send", 17)} ${expired ? "Reply window closed" : state.busy === "send" ? "Sending…" : "Send to Client"}
        </button>
      </div>
    </section>`;
}

function composerView(item) {
  const reset = currentReset();
  const turn = reset?.turn ?? null;
  const draft = reset?.draft ?? null;
  const status = draftStatus({ ...item, reset });

  if (status === "ready" || status === "held") {
    return readyComposer(item, reset);
  }
  if (status === "failed") return failureComposer(reset);
  if (status === "preparing") {
    return `
      <section class="reset-progress">
        <span class="reset-spinner" aria-hidden="true"></span>
        <div>
          <strong>AI is preparing this reply automatically</strong>
          <p>No button press is required. Detailed complaints or attachments may take several minutes. This panel will change to Draft Ready or show a clear failure.</p>
        </div>
      </section>`;
  }
  if (status === "historical") {
    if (turn) return failureComposer(reset);
    return `
      <section class="reset-historical">
        <strong>Historical conversation</strong>
        <p>This message predates the reset workflow, so it has no reset draft. New incoming messages will be drafted automatically.</p>
      </section>`;
  }
  if (status === "waiting" || status === "sent") {
    return `
      <section class="reset-historical">
        <strong>Waiting for the client</strong>
        <p>Hera sent the latest message. A new client reply will automatically start a fresh AI draft.</p>
      </section>`;
  }
  return `<section class="reset-historical"><strong>No current reply required</strong><p>Select a conversation whose latest message is from the client.</p></section>`;
}

function detailsView(item) {
  if (!state.detailsOpen || !item) return "";
  const reset = currentReset();
  const tasks = Array.isArray(state.detail?.tasks) ? state.detail.tasks : [];
  const openTasks = tasks.filter((task) => !["resolved", "cancelled"].includes(task.status));
  return `
    <div class="reset-details-backdrop" data-action="close-details">
      <aside class="reset-details" role="dialog" aria-modal="true" aria-label="Client details" data-details-panel>
        <header class="reset-details__header">
          <h2>Client details</h2>
          <button type="button" class="reset-icon-button" data-action="close-details" aria-label="Close details">${icon("close")}</button>
        </header>
        <div class="reset-details__body">
          <section class="reset-detail-section">
            <h3>Conversation</h3>
            <dl class="reset-detail-list">
              <div><dt>Client</dt><dd>${escapeHtml(item.clientDisplayName)}</dd></div>
              <div><dt>WhatsApp</dt><dd>ending ${escapeHtml(item.phoneEnding)}</dd></div>
              <div><dt>Channel</dt><dd>Tanglin Mall WhatsApp</dd></div>
              <div><dt>Human handling</dt><dd>${item.operatingMode === "management" ? "Active — AI drafting continues" : "Not active"}</dd></div>
              <div><dt>Reply window</dt><dd>${replyWindowOpen(item) ? "Open" : "Closed"}</dd></div>
            </dl>
          </section>
          <section class="reset-detail-section">
            <h3>Current AI turn</h3>
            <dl class="reset-detail-list">
              <div><dt>Status</dt><dd>${escapeHtml(statusPresentation({ ...item, reset }).label)}</dd></div>
              <div><dt>Turn version</dt><dd>${escapeHtml(reset?.turn?.version ?? "—")}</dd></div>
              <div><dt>Fragments</dt><dd>${escapeHtml(reset?.turn?.fragmentIds?.length ?? "—")}</dd></div>
              <div><dt>Model</dt><dd>${escapeHtml(reset?.draft?.modelId || "—")}</dd></div>
              <div><dt>Model calls</dt><dd>${escapeHtml(reset?.draft?.modelCalls ?? "—")}</dd></div>
              <div><dt>Failure</dt><dd>${escapeHtml(reset?.draft?.failureCode || "—")}</dd></div>
            </dl>
          </section>
          <section class="reset-detail-section">
            <h3>Open front-desk items</h3>
            ${openTasks.length ? openTasks.map((task) => `
              <div class="reset-task">
                <strong>${escapeHtml(cleanText(task.summary || task.taskType))}</strong>
                ${escapeHtml(cleanText(task.requestedAction || ""))}
              </div>`).join("") : `<p class="reset-draft-note">No open task is recorded.</p>`}
          </section>
        </div>
      </aside>
    </div>`;
}

function chatView() {
  const item = currentItem();
  if (!item) {
    return `<section class="reset-idle"><div><h2>Select a conversation</h2><p>Choose a client from the inbox to review the full conversation and current reply state.</p></div></section>`;
  }
  const status = statusPresentation({ ...item, reset: currentReset() });
  const risk = riskPresentation(item.currentRisk);
  const messages = Array.isArray(state.detail?.messages) ? state.detail.messages : [];
  return `
    <section class="reset-chat">
      <header class="reset-chat__header">
        <div class="reset-chat__actions">
          <button type="button" class="reset-icon-button reset-back" data-action="back" aria-label="Back to inbox">${icon("back")}</button>
          <div class="reset-chat__identity">
            <h2>${escapeHtml(item.clientDisplayName)}</h2>
            <p>WhatsApp ending ${escapeHtml(item.phoneEnding)} · Tanglin Mall</p>
            <div class="reset-chat__meta">
              ${chip(status.label, status.tone)}
              ${item.operatingMode === "management" ? chip("Human handling — drafting continues", "purple") : ""}
              ${risk ? chip(risk.label, risk.tone) : ""}
            </div>
          </div>
        </div>
        <div class="reset-chat__actions">
          <button type="button" class="reset-icon-button" data-action="refresh" aria-label="Refresh conversation" ${state.busy ? "disabled" : ""}>${icon("refresh")}</button>
          <button type="button" class="reset-icon-button" data-action="details" aria-label="Client details">${icon("info")}</button>
        </div>
      </header>
      <div class="reset-thread" data-thread>
        ${state.loadingConversation && messages.length === 0
          ? `<div class="reset-empty-list">Loading conversation…</div>`
          : messages.length
            ? messages.map(messageView).join("")
            : `<div class="reset-empty-list">No messages are available.</div>`}
      </div>
      <footer class="reset-composer-wrap">
        <div class="reset-state-card">${composerView(item)}</div>
      </footer>
      ${detailsView(item)}
    </section>`;
}

function workspaceView() {
  const shortCommit = state.deployment?.shortCommit || "checking";
  return `
    <main class="reset-shell">
      <header class="reset-topbar">
        <div class="reset-brand">
          <div class="reset-brand__mark">H</div>
          <div>
            <strong>Hera Reception Desk</strong>
            <span>Tanglin Mall WhatsApp · Human-approved delivery</span>
          </div>
        </div>
        <div class="reset-topbar__right">
          <span class="reset-version">Staging · ${escapeHtml(shortCommit)}</span>
          <button type="button" class="reset-staff-button" data-action="logout" title="Sign out">
            ${escapeHtml(state.staff?.displayName || "Hera staff")} ${icon("logout", 15)}
          </button>
        </div>
      </header>
      <div class="reset-workspace">
        ${inboxView()}
        ${chatView()}
      </div>
      ${state.notice ? `<div class="reset-notice ${state.notice.type === "error" ? "reset-notice--error" : ""}">${escapeHtml(state.notice.message)}</div>` : ""}
    </main>`;
}

function render(options = {}) {
  captureThreadPosition();
  if (!state.authKnown) root.innerHTML = loadingView();
  else if (!state.staff) root.innerHTML = loginView(options.loginError || "");
  else root.innerHTML = workspaceView();
  document.body.dataset.resetView = state.selectedConversationId ? "conversation" : "inbox";
  restoreThreadPosition(Boolean(options.forceThreadBottom));
}

function syncDraftFromState(resetState, force = false) {
  const draft = resetState?.draft ?? null;
  if (!draft || !["ready", "held"].includes(draft.status)) {
    if (force || !state.draftDirty) {
      state.draftText = "";
      state.loadedDraftId = null;
      state.draftDirty = false;
    }
    return;
  }
  if (force || !state.draftDirty || state.loadedDraftId !== draft.id) {
    state.draftText = cleanText(draft.candidateText || "");
    state.loadedDraftId = draft.id;
    state.draftDirty = false;
    state.manualMode = false;
  }
}

async function loadInbox({ quiet = false } = {}) {
  if (state.loadingInbox) return;
  state.loadingInbox = true;
  if (!quiet) render();
  try {
    const payload = await request("/api/command-centre/reset-inbox?limit=300");
    state.conversations = Array.isArray(payload.conversations)
      ? payload.conversations
      : [];
    state.deployment = payload.deployment ?? null;
    if (
      state.selectedConversationId &&
      !state.conversations.some((item) => item.id === state.selectedConversationId)
    ) {
      state.selectedConversationId = null;
      state.detail = null;
      state.resetState = null;
      state.draftText = "";
      state.loadedDraftId = null;
      state.draftDirty = false;
    }
  } finally {
    state.loadingInbox = false;
  }
}

async function loadConversation(conversationId, { quiet = false, forceDraft = false } = {}) {
  if (!conversationId || state.loadingConversation) return;
  state.loadingConversation = true;
  if (!quiet) render();
  try {
    const [detailPayload, resetPayload] = await Promise.all([
      request(`/api/command-centre/conversation?id=${encodeURIComponent(conversationId)}`),
      request(`/api/command-centre/reset-state?conversationId=${encodeURIComponent(conversationId)}`),
    ]);
    if (state.selectedConversationId !== conversationId) return;
    state.detail = detailPayload.detail ?? null;
    state.resetState = resetPayload.state ?? null;
    const item = currentItem();
    if (item) item.reset = state.resetState;
    syncDraftFromState(state.resetState, forceDraft);
  } finally {
    state.loadingConversation = false;
  }
}

async function refreshAll({ quiet = false } = {}) {
  const selected = state.selectedConversationId;
  await loadInbox({ quiet });
  if (selected && state.selectedConversationId === selected) {
    await loadConversation(selected, { quiet });
  }
  render();
}

async function selectConversation(conversationId) {
  state.selectedConversationId = conversationId;
  state.detail = null;
  state.resetState = currentItem()?.reset ?? null;
  state.draftDirty = false;
  state.manualMode = false;
  state.detailsOpen = false;
  state.threadNearBottom = true;
  syncDraftFromState(state.resetState, true);
  render();
  await loadConversation(conversationId, { forceDraft: true });
  render({ forceThreadBottom: true });
}

async function login(form) {
  const data = new FormData(form);
  state.busy = "login";
  render();
  try {
    const payload = await request("/api/command-centre/auth/login", {
      method: "POST",
      body: {
        email: String(data.get("email") || ""),
        password: String(data.get("password") || ""),
      },
    });
    state.staff = payload.staff ?? null;
    state.csrfToken = payload.csrfToken ?? "";
    state.busy = null;
    await refreshAll();
  } catch (error) {
    state.busy = null;
    render({ loginError: error instanceof Error ? error.message : "Sign-in failed." });
  }
}

async function logout() {
  state.busy = "logout";
  render();
  try {
    await request("/api/command-centre/auth/logout", { method: "POST", body: {} });
  } catch {
    // Browser credentials are still cleared by the idempotent logout endpoint.
  }
  state.staff = null;
  state.csrfToken = "";
  state.busy = null;
  state.conversations = [];
  state.selectedConversationId = null;
  state.detail = null;
  state.resetState = null;
  render();
}

async function regenerate() {
  const item = currentItem();
  const reset = currentReset();
  if (!item || !reset?.turn) return;
  state.busy = "regenerate";
  render();
  try {
    await request("/api/command-centre/reset-regenerate", {
      method: "POST",
      body: {
        turnId: reset.turn.id,
        expectedCandidateHash: reset.draft?.candidateHash ?? null,
        expectedPhoneEnding: item.phoneEnding,
      },
    });
    state.draftDirty = false;
    state.manualMode = false;
    setNotice("A fresh AI reply is being prepared automatically.");
    await refreshAll({ quiet: true });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The AI reply could not be retried.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

async function saveManual() {
  const item = currentItem();
  const reset = currentReset();
  if (!item || !reset?.turn || !state.draftText.trim()) return;
  state.busy = "manual";
  render();
  try {
    await request("/api/command-centre/reset-manual", {
      method: "POST",
      body: {
        turnId: reset.turn.id,
        expectedPhoneEnding: item.phoneEnding,
        messageText: state.draftText,
      },
    });
    state.manualMode = false;
    state.draftDirty = false;
    await loadConversation(item.id, { quiet: true, forceDraft: true });
    setNotice("Manual reply saved. Review the exact text before sending.");
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The manual reply could not be saved.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

async function takeover() {
  const item = currentItem();
  if (!item || item.operatingMode === "management") return;
  state.busy = "takeover";
  render();
  try {
    await request("/api/command-centre/conversation", {
      method: "POST",
      body: {
        action: "takeover",
        conversationId: item.id,
        reason: "Receptionist selected Take Over / Hold in the human-approved reset workspace.",
        takeoverUntil: null,
      },
    });
    item.operatingMode = "management";
    setNotice("Human handling is active. AI drafting will continue for future client messages.");
    await loadInbox({ quiet: true });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Human handling could not be activated.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

async function sendReply() {
  const item = currentItem();
  const reset = currentReset();
  const draft = reset?.draft;
  if (
    !item ||
    !reset?.turn ||
    !draft ||
    draft.status !== "ready" ||
    !draft.candidateHash ||
    !state.draftText.trim()
  ) return;

  state.busy = "send";
  render();
  try {
    const result = await request("/api/command-centre/reset-message", {
      method: "POST",
      body: {
        draftRunId: draft.id,
        expectedTurnId: reset.turn.id,
        expectedCandidateHash: draft.candidateHash,
        expectedPhoneEnding: item.phoneEnding,
        messageText: state.draftText,
      },
    });
    state.draftDirty = false;
    if (result.state === "sent_pending_audit_reconciliation") {
      setNotice(
        "WhatsApp accepted the message. The audit record needs reconciliation; do not send again.",
        "error",
      );
    } else {
      setNotice("Message sent from the Tanglin Mall WhatsApp.");
    }
    await refreshAll({ quiet: true });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The message was not sent.", "error");
  } finally {
    state.busy = null;
    render();
  }
}

root.addEventListener("submit", (event) => {
  const form = event.target;
  if (form instanceof HTMLFormElement && form.matches("[data-login-form]")) {
    event.preventDefault();
    void login(form);
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
  if (target instanceof HTMLTextAreaElement && target.matches("[data-composer]")) {
    state.draftText = target.value;
    state.draftDirty = true;
  }
});

root.addEventListener("scroll", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("[data-thread]")) {
    state.threadScrollTop = target.scrollTop;
    state.threadNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 90;
  }
}, true);

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest("[data-action]")
    : null;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;

  if (action === "select") {
    void selectConversation(target.dataset.conversationId || "");
  } else if (action === "filter") {
    const filter = target.dataset.filter;
    if (FILTERS.includes(filter)) {
      state.filter = filter;
      render();
    }
  } else if (action === "refresh") {
    void refreshAll();
  } else if (action === "back") {
    state.selectedConversationId = null;
    state.detailsOpen = false;
    state.detail = null;
    state.resetState = null;
    state.draftDirty = false;
    render();
  } else if (action === "details") {
    state.detailsOpen = true;
    render();
  } else if (action === "close-details") {
    if (target.matches("[data-details-panel]")) return;
    state.detailsOpen = false;
    render();
  } else if (action === "expand-message") {
    const id = target.dataset.messageId;
    if (id) {
      if (state.expandedMessages.has(id)) state.expandedMessages.delete(id);
      else state.expandedMessages.add(id);
      render();
    }
  } else if (action === "regenerate") {
    void regenerate();
  } else if (action === "manual") {
    state.manualMode = true;
    state.draftText = "";
    state.draftDirty = true;
    render();
  } else if (action === "cancel-manual") {
    state.manualMode = false;
    state.draftText = "";
    state.draftDirty = false;
    render();
  } else if (action === "save-manual") {
    void saveManual();
  } else if (action === "takeover") {
    void takeover();
  } else if (action === "send") {
    void sendReply();
  } else if (action === "logout") {
    void logout();
  }
});

async function initialise() {
  render();
  try {
    const session = await request("/api/command-centre/auth/session");
    state.authKnown = true;
    if (session.authenticated) {
      state.staff = session.staff;
      state.csrfToken = session.csrfToken || "";
      await loadInbox({ quiet: true });
    }
  } catch {
    state.authKnown = true;
    state.staff = null;
  }
  render();

  state.pollTimer = window.setInterval(() => {
    if (!state.staff || document.visibilityState !== "visible" || state.busy) return;
    void refreshAll({ quiet: true });
  }, POLL_MS);
}

void initialise();
