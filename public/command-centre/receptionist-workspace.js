const root = document.querySelector("#reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Front Desk root element was not found.");
}

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const FILTERS = ["needs", "waiting", "answered", "held", "all"];

const state = {
  staff: null,
  conversations: [],
  queueItems: [],
  selectedConversationId: null,
  detail: null,
  draft: "",
  originalDraft: "",
  noteDraft: "",
  loading: true,
  loadingConversation: false,
  busy: null,
  deliveryEnabled: false,
  notice: null,
  staffOpen: false,
  detailsOpen: false,
  filter: "needs",
  search: "",
  lastSyncedAt: null,
  draftDirty: false,
  expandedMessages: new Set(),
  scrollThreadOnRender: false,
};

function icon(name, size = 20) {
  const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const paths = {
    search: `<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.8-3.8"></path>`,
    refresh: `<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path>`,
    back: `<path d="m15 18-6-6 6-6"></path>`,
    info: `<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>`,
    close: `<path d="m6 6 12 12M18 6 6 18"></path>`,
    check: `<path d="m5 12 4 4L19 6"></path>`,
    clock: `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>`,
    hold: `<rect x="7" y="5" width="3" height="14" rx="1"></rect><rect x="14" y="5" width="3" height="14" rx="1"></rect>`,
    sparkle: `<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"></path><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"></path>`,
    send: `<path d="m3 11 18-8-8 18-2-8-8-2Z"></path><path d="m11 13 10-10"></path>`,
    note: `<path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h8M8 16h5"></path>`,
    calendar: `<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M16 3v4M8 3v4M3 10h18"></path>`,
    chevron: `<path d="m9 18 6-6-6-6"></path>`,
  };
  return `<svg ${common}>${paths[name] ?? paths.info}</svg>`;
}

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

function cleanDisplayText(value) {
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

function compact(value, maximum = 88) {
  const text = cleanDisplayText(value).replace(/\s+/g, " ");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function initials(name) {
  const cleaned = cleanDisplayText(name);
  if (!cleaned) return "H";
  return cleaned
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

function parsedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function singaporeDayKey(value) {
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
  const today = singaporeDayKey(new Date());
  const day = singaporeDayKey(date);
  if (day === today) return "Today";
  const yesterday = singaporeDayKey(new Date(Date.now() - 86_400_000));
  if (day === yesterday) return "Yesterday";
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
  if (singaporeDayKey(date) === singaporeDayKey(new Date())) return formatTime(date);
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

function formatMoney(value, currency) {
  if (!Number.isFinite(Number(value))) return null;
  try {
    return new Intl.NumberFormat("en-SG", {
      style: "currency",
      currency: currency || "SGD",
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${currency || "SGD"} ${Number(value).toFixed(2)}`;
  }
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "";
  if (milliseconds <= 0) return "Closed";
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.max(1, Math.floor((milliseconds % 3_600_000) / 60_000));
  return hours >= 1 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

function candidateMap() {
  return new Map(
    state.queueItems
      .filter((item) => item?.conversationId)
      .map((item) => [item.conversationId, item]),
  );
}

function candidateForConversation(conversationId) {
  return candidateMap().get(conversationId) ?? null;
}

function currentConversation() {
  return state.conversations.find(
    (conversation) => conversation.id === state.selectedConversationId,
  ) ?? null;
}

function currentCandidate() {
  const conversation = currentConversation();
  return conversation ? candidateForConversation(conversation.id) : null;
}

function replyWindowRemaining(conversation) {
  if (!conversation || conversation.lastMessageDirection !== "inbound") return null;
  const date = parsedDate(conversation.lastMessageAt);
  return date ? date.getTime() + REPLY_WINDOW_MS - Date.now() : null;
}

function isAnsweredToday(conversation) {
  return conversation?.lastMessageDirection === "outbound" &&
    singaporeDayKey(conversation.lastMessageAt) === singaporeDayKey(new Date());
}

function conversationStatus(conversation) {
  if (!conversation) return { key: "idle", label: "No conversation", tone: "neutral" };
  if (conversation.operatingMode === "management") {
    return { key: "held", label: "Human handling", tone: "purple" };
  }
  if (candidateForConversation(conversation.id)) {
    return { key: "draft", label: "AI draft ready", tone: "green" };
  }
  if (conversation.lastMessageDirection === "inbound") {
    const remaining = replyWindowRemaining(conversation);
    if (remaining !== null && remaining <= 0) {
      return { key: "expired", label: "Follow-up needed", tone: "red" };
    }
    return { key: "needs", label: "Needs reply", tone: "gold" };
  }
  if (conversation.lastMessageDirection === "outbound") {
    return { key: "waiting", label: "Waiting for client", tone: "blue" };
  }
  return { key: "idle", label: "No recent message", tone: "neutral" };
}

function riskPresentation(risk) {
  if (risk === "black") return { label: "Emergency", tone: "red" };
  if (risk === "red") return { label: "Urgent", tone: "red" };
  if (risk === "amber") return { label: "Needs care", tone: "gold" };
  return null;
}

function filterCounts() {
  const counts = {
    needs: 0,
    waiting: 0,
    answered: 0,
    held: 0,
    all: state.conversations.length,
  };
  for (const conversation of state.conversations) {
    const status = conversationStatus(conversation).key;
    if (["draft", "needs", "expired"].includes(status)) counts.needs += 1;
    if (status === "waiting") counts.waiting += 1;
    if (status === "held") counts.held += 1;
    if (isAnsweredToday(conversation)) counts.answered += 1;
  }
  return counts;
}

function matchesFilter(conversation) {
  const status = conversationStatus(conversation).key;
  if (state.filter === "all") return true;
  if (state.filter === "needs") return ["draft", "needs", "expired"].includes(status);
  if (state.filter === "waiting") return status === "waiting";
  if (state.filter === "answered") return isAnsweredToday(conversation);
  if (state.filter === "held") return status === "held";
  return true;
}

function riskRank(risk) {
  return { black: 4, red: 3, amber: 2, green: 1 }[risk] ?? 0;
}

function statusRank(status) {
  return { draft: 0, needs: 1, expired: 2, held: 3, waiting: 4, idle: 5 }[status] ?? 6;
}

function visibleConversations() {
  const search = state.search.trim().toLowerCase();
  return state.conversations
    .filter((conversation) => {
      if (!matchesFilter(conversation)) return false;
      if (!search) return true;
      return [
        conversation.clientDisplayName,
        conversation.phoneEnding,
        conversation.lastMessagePreview,
      ].some((value) => cleanDisplayText(value).toLowerCase().includes(search));
    })
    .sort((left, right) => {
      if (state.filter === "needs") {
        const statusDifference =
          statusRank(conversationStatus(left).key) -
          statusRank(conversationStatus(right).key);
        if (statusDifference !== 0) return statusDifference;
        const riskDifference = riskRank(right.currentRisk) - riskRank(left.currentRisk);
        if (riskDifference !== 0) return riskDifference;
        return Date.parse(left.lastMessageAt) - Date.parse(right.lastMessageAt);
      }
      if (state.filter === "held") {
        const riskDifference = riskRank(right.currentRisk) - riskRank(left.currentRisk);
        if (riskDifference !== 0) return riskDifference;
      }
      return Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt);
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
  }, 5200);
}

function statusChip(status, compactChip = false) {
  return `<span class="fd-chip fd-chip--${escapeHtml(status.tone)} ${compactChip ? "fd-chip--compact" : ""}">${escapeHtml(status.label)}</span>`;
}

function loadingView() {
  return `
    <main class="fd-loading">
      <section class="fd-loading__card">
        <div class="fd-brand-mark">H</div>
        <p class="fd-eyebrow">Hera Hair Beauty</p>
        <h1>Opening Front Desk</h1>
        <p>Loading the complete Tanglin WhatsApp inbox and current AI drafts.</p>
        <div class="fd-spinner" aria-label="Loading"></div>
      </section>
    </main>
  `;
}

function loginView() {
  return `
    <main class="fd-login">
      <form class="fd-login__card" data-form="login">
        <div class="fd-brand-mark">H</div>
        <p class="fd-eyebrow">Hera Hair Beauty</p>
        <h1>Front Desk sign-in</h1>
        <p>Use an authorised Hera staff account.</p>
        <label class="fd-field"><span>Email</span><input type="email" name="email" required autocomplete="username"></label>
        <label class="fd-field"><span>Password</span><input type="password" name="password" required minlength="12" autocomplete="current-password"></label>
        <button class="fd-button fd-button--primary" type="submit" ${state.busy ? "disabled" : ""}>${state.busy === "login" ? "Signing in…" : "Sign in"}</button>
        ${state.notice?.type === "error" ? `<p class="fd-error">${escapeHtml(state.notice.message)}</p>` : ""}
      </form>
    </main>
  `;
}

function topbar() {
  const staffName = state.staff?.displayName || "Hera staff";
  const synced = state.lastSyncedAt ? `Updated ${formatTime(state.lastSyncedAt)}` : "Connecting";
  return `
    <header class="fd-topbar">
      <div class="fd-brand">
        <div class="fd-brand-mark fd-brand-mark--small">H</div>
        <div class="fd-brand-copy"><strong>Hera Reception Desk</strong><span>AI-assisted client service</span></div>
      </div>
      <div class="fd-topbar-spacer"></div>
      <div class="fd-sync" aria-label="Tanglin WhatsApp connection">
        <span class="fd-live-dot"></span><span class="fd-sync__channel">Tanglin WhatsApp</span><small>${escapeHtml(synced)}</small>
      </div>
      <button class="fd-icon-button" type="button" data-action="refresh" aria-label="Refresh inbox" title="Refresh inbox">${icon("refresh")}</button>
      <button class="fd-staff-button" type="button" data-action="staff" aria-label="Open staff account" title="${escapeHtml(staffName)}">${escapeHtml(initials(staffName))}</button>
    </header>
  `;
}

function inboxHeader() {
  const counts = filterCounts();
  const labels = {
    needs: "Needs reply",
    waiting: "Waiting",
    answered: "Answered today",
    held: "On hold",
    all: "All conversations",
  };
  return `
    <header class="fd-inbox-header">
      <div class="fd-inbox-title">
        <div><p class="fd-eyebrow">Tanglin WhatsApp</p><h1>Inbox</h1></div>
        <span><strong>${counts.needs}</strong> need reply · ${counts.all} total</span>
      </div>
      <label class="fd-search">
        ${icon("search", 18)}
        <input type="search" value="${escapeHtml(state.search)}" placeholder="Search client, last 4 digits or message" aria-label="Search conversations" data-search-input>
        ${state.search ? `<button type="button" data-action="clear-search" aria-label="Clear search">${icon("close", 16)}</button>` : ""}
      </label>
      <nav class="fd-tabs" aria-label="Inbox filters">
        ${FILTERS.map((filter) => `
          <button type="button" class="fd-tab ${state.filter === filter ? "fd-tab--active" : ""}" data-action="filter" data-filter="${filter}" aria-pressed="${state.filter === filter ? "true" : "false"}">
            <span>${labels[filter]}</span><strong>${counts[filter]}</strong>
          </button>
        `).join("")}
      </nav>
    </header>
  `;
}

function conversationRow(conversation) {
  const status = conversationStatus(conversation);
  const risk = riskPresentation(conversation.currentRisk);
  const selected = conversation.id === state.selectedConversationId;
  const preview = cleanDisplayText(conversation.lastMessagePreview) || "No message preview";
  return `
    <button type="button" class="fd-conversation ${selected ? "fd-conversation--selected" : ""}" data-action="select-conversation" data-conversation-id="${escapeHtml(conversation.id)}" aria-current="${selected ? "true" : "false"}">
      <span class="fd-avatar">${escapeHtml(initials(conversation.clientDisplayName))}</span>
      <span class="fd-conversation__body">
        <span class="fd-conversation__title"><strong>${escapeHtml(cleanDisplayText(conversation.clientDisplayName))}</strong><time>${escapeHtml(formatRowTime(conversation.lastMessageAt))}</time></span>
        <span class="fd-conversation__preview">${escapeHtml(compact(preview, 78))}</span>
        <span class="fd-conversation__meta">
          ${statusChip(status, true)}
          ${risk ? statusChip(risk, true) : ""}
          ${conversation.openTaskCount > 0 ? `<span class="fd-meta-label">${conversation.openTaskCount} open</span>` : ""}
        </span>
      </span>
    </button>
  `;
}

function inboxList() {
  const conversations = visibleConversations();
  if (!conversations.length) {
    return `<section class="fd-empty-list"><div class="fd-empty-icon">${icon("search", 22)}</div><h2>No conversations found</h2><p>Try another filter or search term.</p></section>`;
  }
  return conversations.map(conversationRow).join("");
}

function inbox() {
  return `<aside class="fd-inbox">${inboxHeader()}<div class="fd-conversation-list" data-inbox-list>${inboxList()}</div></aside>`;
}

function messageDisplay(message) {
  const cleaned = cleanDisplayText(message.text);
  if (cleaned) return cleaned;
  if (message.kind === "image") return "Photo";
  if (message.kind === "audio" || message.kind === "voice") return "Voice message";
  if (message.kind === "video") return "Video";
  if (message.kind === "document") return "Document";
  if (message.kind === "sticker") return "Sticker";
  return `[${cleanDisplayText(message.kind || "WhatsApp message")}]`;
}

function deliveryLabel(message) {
  if (message.direction !== "outbound") return "";
  const status = String(message.deliveryStatus || "").toLowerCase();
  if (status === "read") return "Read";
  if (status === "delivered") return "Delivered";
  if (status === "sent") return "Sent";
  if (status === "failed") return "Failed";
  return "";
}

function renderTranscriptMessages(messages) {
  let previousDay = "";
  return messages.map((message) => {
    const timestamp = message.providerTimestamp || message.createdAt;
    const day = singaporeDayKey(timestamp);
    const divider = day && day !== previousDay ? `<div class="fd-day-divider"><span>${escapeHtml(formatDay(timestamp))}</span></div>` : "";
    if (day) previousDay = day;
    const text = messageDisplay(message);
    const long = text.length > 620 || text.split("\n").length > 10;
    const expanded = state.expandedMessages.has(message.id);
    const delivery = deliveryLabel(message);
    return `${divider}
      <article class="fd-message fd-message--${message.direction === "outbound" ? "outbound" : "inbound"} ${message.kind === "reaction" ? "fd-message--reaction" : ""}">
        <div class="fd-message__bubble">
          <p class="${long && !expanded ? "fd-message__text--clamped" : ""}">${escapeHtml(text)}</p>
          ${long ? `<button type="button" class="fd-show-more" data-action="toggle-message" data-message-id="${escapeHtml(message.id)}">${expanded ? "Show less" : "Show full message"}</button>` : ""}
          <div class="fd-message__meta">${message.aiGenerated ? "<span>AI</span>" : ""}${delivery ? `<span>${escapeHtml(delivery)}</span>` : ""}<time>${escapeHtml(formatTime(timestamp))}</time></div>
        </div>
      </article>`;
  }).join("");
}

function detailJobState() {
  const jobs = Array.isArray(state.detail?.jobs) ? state.detail.jobs : [];
  const inbound = latestInboundMessage();
  return inbound ? jobs.find((item) => item.sourceMessageId === inbound.id)?.status ?? null : null;
}

function latestInboundMessage() {
  const messages = Array.isArray(state.detail?.messages) ? state.detail.messages : [];
  return [...messages].reverse().find((message) => message.direction === "inbound") ?? null;
}

function latestCandidateForInbound() {
  const candidates = Array.isArray(state.detail?.candidates) ? state.detail.candidates : [];
  const inbound = latestInboundMessage();
  return inbound ? candidates.find((candidate) => candidate.sourceMessageId === inbound.id) ?? null : null;
}

function conversationHeader(conversation) {
  const status = conversationStatus(conversation);
  const risk = riskPresentation(conversation.currentRisk);
  return `
    <header class="fd-client-header">
      <button class="fd-icon-button fd-back-button" type="button" data-action="back" aria-label="Back to inbox">${icon("back")}</button>
      <span class="fd-avatar fd-avatar--large">${escapeHtml(initials(conversation.clientDisplayName))}</span>
      <div class="fd-client-copy"><strong>${escapeHtml(cleanDisplayText(conversation.clientDisplayName))}</strong><span>WhatsApp ending ${escapeHtml(conversation.phoneEnding)}</span></div>
      <div class="fd-client-status">${statusChip(status)}${risk ? statusChip(risk) : ""}</div>
      <button class="fd-details-button" type="button" data-action="open-details">${icon("info", 18)}<span>Details</span></button>
    </header>
  `;
}

function composerStatusCard(conversation) {
  const status = conversationStatus(conversation);
  const jobStatus = detailJobState();
  const latestCandidate = latestCandidateForInbound();
  if (status.key === "held") {
    return `<footer class="fd-composer fd-composer--status"><div class="fd-status-card"><div class="fd-status-card__icon fd-status-card__icon--purple">${icon("hold")}</div><div><strong>Human handling is active</strong><p>The AI is paused for this conversation. Front desk can respond through the Tanglin workflow after completing the necessary checks.</p></div><button type="button" class="fd-button fd-button--secondary" data-action="return-ai" ${state.busy ? "disabled" : ""}>Return to AI</button></div></footer>`;
  }
  if (status.key === "waiting") {
    return `<footer class="fd-composer fd-composer--status"><div class="fd-status-card"><div class="fd-status-card__icon fd-status-card__icon--blue">${icon("clock")}</div><div><strong>Waiting for the client</strong><p>The latest message was sent from Hera. This conversation returns to Needs reply when the client responds.</p></div></div></footer>`;
  }
  if (status.key === "expired") {
    return `<footer class="fd-composer fd-composer--status"><div class="fd-status-card"><div class="fd-status-card__icon fd-status-card__icon--red">${icon("clock")}</div><div><strong>WhatsApp reply window closed</strong><p>The conversation remains visible, but a free-form API reply cannot be sent after 24 hours. Follow the approved WhatsApp template or manual process.</p></div><button type="button" class="fd-button fd-button--secondary" data-action="takeover" ${state.busy ? "disabled" : ""}>Take Over / Hold</button></div></footer>`;
  }
  const failed = jobStatus === "dead" || Boolean(latestCandidate);
  return `<footer class="fd-composer fd-composer--status"><div class="fd-status-card"><div class="fd-status-card__icon fd-status-card__icon--gold">${icon("sparkle")}</div><div><strong>${failed ? "No send-ready AI draft" : "AI reply is being prepared"}</strong><p>${failed ? "The latest draft did not pass the send-ready gate. Review the conversation and use Take Over / Hold for manual handling." : "The screen refreshes automatically. Use Refresh if the client has just messaged."}</p></div><div class="fd-status-card__actions"><button type="button" class="fd-button fd-button--secondary" data-action="refresh" ${state.busy ? "disabled" : ""}>Refresh</button><button type="button" class="fd-button fd-button--ghost" data-action="takeover" ${state.busy ? "disabled" : ""}>Take Over / Hold</button></div></div></footer>`;
}

function replyComposer(conversation) {
  const remaining = replyWindowRemaining(conversation);
  const windowLabel = remaining === null ? "Human review required" : formatDuration(remaining);
  return `
    <footer class="fd-composer">
      <div class="fd-composer__inner">
        <div class="fd-composer__heading">
          <div><span class="fd-composer__title">Reply to client</span><span class="fd-composer__subtitle">AI suggested reply — review and edit before sending</span></div>
          <span class="fd-window-label">${icon("clock", 16)} ${escapeHtml(windowLabel)}</span>
        </div>
        <textarea id="reception-draft" class="fd-draft" maxlength="4000" aria-label="Editable reply to client" ${state.busy ? "disabled" : ""}>${escapeHtml(state.draft)}</textarea>
        <div class="fd-composer__bottom">
          <div class="fd-draft-state ${state.draftDirty ? "fd-draft-state--edited" : ""}">${state.draftDirty ? "Edited by you — the exact text above will be sent." : "AI draft ready for human review."}<span>${state.draft.length}/4000</span></div>
          <div class="fd-composer__actions">
            <button type="button" class="fd-button fd-button--ghost" data-action="takeover" ${state.busy ? "disabled" : ""}>Take Over / Hold</button>
            <button type="button" class="fd-button fd-button--secondary" data-action="regenerate" ${state.busy ? "disabled" : ""}>${state.busy === "regenerate" ? "Creating reply…" : "Regenerate"}</button>
            <button type="button" class="fd-button fd-button--primary fd-button--send" data-action="send" ${!state.deliveryEnabled || state.busy || !state.draft.trim() ? "disabled" : ""}>${icon("send", 18)} ${state.busy === "send" ? "Sending…" : "Send to Client"}</button>
          </div>
        </div>
        <p class="fd-channel-note">Sent only from Tanglin WhatsApp. Nothing is sent until a human presses Send to Client.</p>
      </div>
    </footer>
  `;
}

function workspaceEmpty() {
  const counts = filterCounts();
  return `<section class="fd-workspace fd-workspace--empty"><div class="fd-welcome"><div class="fd-welcome__mark">${icon("sparkle", 26)}</div><p class="fd-eyebrow">Front desk workspace</p><h2>Select a conversation</h2><p>Review the full WhatsApp history, check or edit the AI reply, then send from the Tanglin number.</p><div class="fd-welcome__summary"><div><strong>${counts.needs}</strong><span>Need reply</span></div><div><strong>${counts.waiting}</strong><span>Waiting</span></div><div><strong>${counts.held}</strong><span>On hold</span></div></div></div></section>`;
}

function workspace() {
  const conversation = currentConversation();
  if (!conversation) return workspaceEmpty();
  const candidate = currentCandidate();
  const messages = Array.isArray(state.detail?.messages) ? state.detail.messages.slice(-140) : [];
  return `
    <section class="fd-workspace">
      ${conversationHeader(conversation)}
      <div class="fd-thread" data-thread><div class="fd-thread__inner">
        ${state.loadingConversation ? `<div class="fd-thread-loading"><div class="fd-spinner"></div><span>Loading conversation…</span></div>` : messages.length ? renderTranscriptMessages(messages) : `<div class="fd-thread-empty"><p>No transcript is available for this conversation.</p></div>`}
      </div></div>
      ${candidate ? replyComposer(conversation) : composerStatusCard(conversation)}
    </section>
  `;
}

function openTasks() {
  const tasks = Array.isArray(state.detail?.tasks) ? state.detail.tasks : [];
  return tasks.filter((task) => task.status !== "resolved" && task.status !== "cancelled");
}

function taskLabel(taskType) {
  const labels = {
    booking_action: "Booking request",
    appointment_change: "Appointment change",
    arrival_issue: "Arrival issue",
    group_booking: "Group booking",
    complaint_review: "Client concern",
    refund_finance: "Refund or payment",
    medical_safety: "Safety concern",
    technical_review: "Technical review",
    privacy_legal: "Privacy request",
    accessibility_arrangement: "Accessibility",
    consent_media: "Media consent",
    lost_property: "Lost property",
    client_requested_human: "Human assistance",
    security_review: "Security review",
    system_failure: "System attention",
    other: "Front desk action",
  };
  return labels[taskType] ?? "Front desk action";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function selectBooking() {
  const bookings = Array.isArray(state.detail?.bookings) ? state.detail.bookings : [];
  if (!bookings.length) return null;
  const now = Date.now();
  const active = bookings
    .filter((booking) => !/cancel/i.test(String(booking.bookingStatus || "")))
    .sort((a, b) => Date.parse(a.appointmentAt) - Date.parse(b.appointmentAt));
  return active.find((booking) => Date.parse(booking.appointmentAt) >= now - 43_200_000) ?? bookings[0];
}

function inferredBookingFacts() {
  const relevant = openTasks().find((task) => ["booking_action", "appointment_change", "arrival_issue"].includes(task.taskType));
  if (!relevant) return null;
  const facts = asObject(relevant.collectedFacts);
  const hasAny = [facts.service, facts.stylist, facts.outlet, facts.date, facts.time].some(Boolean);
  return hasAny ? { task: relevant, facts } : null;
}

function bookingContextSection() {
  const booking = selectBooking();
  const inferred = inferredBookingFacts();
  if (booking) {
    const price = formatMoney(booking.price, booking.currency);
    return `
      <section class="fd-context-section">
        <div class="fd-section-heading"><div><p class="fd-eyebrow">Appointment context</p><h3>Recorded booking</h3></div><span class="fd-context-badge">Check Timely</span></div>
        <div class="fd-booking-card">
          <strong>${escapeHtml(cleanDisplayText(booking.serviceName))}</strong>
          <dl class="fd-context-list">
            <div><dt>Date & time</dt><dd>${escapeHtml(formatDateTime(booking.appointmentAt))}</dd></div>
            <div><dt>Stylist</dt><dd>${escapeHtml(cleanDisplayText(booking.stylistName || "Not recorded"))}</dd></div>
            <div><dt>Outlet</dt><dd>${escapeHtml(cleanDisplayText(booking.locationName || "Not recorded"))}</dd></div>
            <div><dt>Status</dt><dd>${escapeHtml(cleanDisplayText(booking.bookingStatus))}</dd></div>
            ${price ? `<div><dt>Recorded price</dt><dd>${escapeHtml(price)}</dd></div>` : ""}
          </dl>
        </div>
        <p class="fd-context-help">This is recorded context, not live Timely availability. Verify in Timely before confirming a booking outcome.</p>
      </section>
    `;
  }
  if (inferred) {
    const { facts, task } = inferred;
    const rows = [
      ["Service", facts.service],
      ["Stylist", facts.stylist],
      ["Outlet", facts.outlet],
      ["Date", facts.date],
      ["Time", facts.time],
    ].filter(([, value]) => value);
    return `
      <section class="fd-context-section">
        <div class="fd-section-heading"><div><p class="fd-eyebrow">Appointment context</p><h3>${escapeHtml(taskLabel(task.taskType))}</h3></div><span class="fd-context-badge">Needs Timely check</span></div>
        <dl class="fd-context-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(cleanDisplayText(value))}</dd></div>`).join("")}</dl>
        <p class="fd-context-help">These details came from the conversation. Verify the actual booking in Timely before confirming any change.</p>
      </section>
    `;
  }
  return `
    <section class="fd-context-section">
      <div class="fd-section-heading"><div><p class="fd-eyebrow">Appointment context</p><h3>No linked booking</h3></div><span class="fd-context-badge">Needs Timely check</span></div>
      <p class="fd-context-empty">Search Timely using the client’s name or WhatsApp ending before confirming availability, changes or cancellations.</p>
    </section>
  `;
}

function taskContextSection() {
  const tasks = openTasks();
  return `
    <section class="fd-context-section">
      <div class="fd-section-heading"><div><p class="fd-eyebrow">Front desk</p><h3>Open items</h3></div><span>${tasks.length}</span></div>
      ${tasks.length ? `<div class="fd-task-list">${tasks.slice(0, 3).map((task) => `<article class="fd-task-row"><div><strong>${escapeHtml(taskLabel(task.taskType))}</strong><p>${escapeHtml(compact(task.summary, 135))}</p></div><span>${escapeHtml(task.priority)}</span></article>`).join("")}</div>` : `<p class="fd-context-empty">No open front desk items.</p>`}
    </section>
  `;
}

function notesSection() {
  const notes = Array.isArray(state.detail?.notes) ? state.detail.notes.slice(0, 4) : [];
  return `
    <section class="fd-context-section fd-context-section--notes">
      <div class="fd-section-heading"><div><p class="fd-eyebrow">Private</p><h3>Internal notes</h3></div><span>${notes.length}</span></div>
      <form class="fd-note-form" data-form="note">
        <textarea id="internal-note" maxlength="4000" placeholder="Add a clear note for the front desk team…" aria-label="Internal note" ${state.busy ? "disabled" : ""}>${escapeHtml(state.noteDraft)}</textarea>
        <button class="fd-button fd-button--secondary" type="submit" ${state.busy || !state.noteDraft.trim() ? "disabled" : ""}>${state.busy === "note" ? "Saving…" : "Add note"}</button>
      </form>
      ${notes.length ? `<div class="fd-note-list">${notes.map((note) => `<article class="fd-note-row"><p>${escapeHtml(cleanDisplayText(note.body))}</p><span>${escapeHtml(note.authorDisplayName)} · ${escapeHtml(formatDateTime(note.createdAt))}</span></article>`).join("")}</div>` : `<p class="fd-context-empty">No internal notes yet.</p>`}
    </section>
  `;
}

function contextPanelContent() {
  const conversation = currentConversation();
  if (!conversation) {
    return `<div class="fd-context-empty-state">${icon("info", 24)}<h3>Client context</h3><p>Select a conversation to view booking details and internal notes.</p></div>`;
  }
  return `${bookingContextSection()}${taskContextSection()}${notesSection()}<a class="fd-advanced-link" href="/command-centre/advanced">Open advanced record ${icon("chevron", 15)}</a>`;
}

function contextPanel() {
  return `<aside class="fd-context-panel"><header class="fd-context-header"><p class="fd-eyebrow">Useful context</p><h2>Client overview</h2></header><div class="fd-context-body">${contextPanelContent()}</div></aside>`;
}

function detailsDrawer() {
  if (!state.detailsOpen) return "";
  return `<div class="fd-drawer-layer"><button class="fd-drawer-backdrop" type="button" data-action="close-details" aria-label="Close details"></button><aside class="fd-drawer" role="dialog" aria-modal="true" aria-label="Client details"><header class="fd-drawer__header"><div><p class="fd-eyebrow">Useful context</p><h2>Client overview</h2></div><button class="fd-icon-button" type="button" data-action="close-details" aria-label="Close details">${icon("close")}</button></header><div class="fd-drawer__body">${contextPanelContent()}</div></aside></div>`;
}

function staffModal() {
  if (!state.staffOpen) return "";
  const previewOwner = state.staff?.email === "vercel-preview-owner@herabeauty.sg";
  return `<div class="fd-modal-layer"><button class="fd-modal-backdrop" type="button" data-action="close-staff" aria-label="Close staff account"></button><section class="fd-modal" role="dialog" aria-modal="true" aria-label="Staff account">${previewOwner ? `<p class="fd-eyebrow">Named human authority</p><h2>Staff sign-in</h2><p>Use the receptionist’s own account so every send is recorded under the correct name.</p><form data-form="staff-login"><label class="fd-field"><span>Email</span><input type="email" name="email" required autocomplete="username"></label><label class="fd-field"><span>Password</span><input type="password" name="password" required minlength="12" autocomplete="current-password"></label><div class="fd-modal__actions"><button type="button" class="fd-button fd-button--ghost" data-action="close-staff">Cancel</button><button type="submit" class="fd-button fd-button--primary" ${state.busy ? "disabled" : ""}>Sign in</button></div></form>` : `<div class="fd-account-avatar">${escapeHtml(initials(state.staff?.displayName))}</div><p class="fd-eyebrow">Current operator</p><h2>${escapeHtml(state.staff?.displayName || "Hera staff")}</h2><p>${escapeHtml(state.staff?.role || "authorised staff")} · actions are recorded under this account.</p><div class="fd-modal__actions fd-modal__actions--stacked"><a class="fd-button fd-button--secondary" href="/command-centre/advanced">Advanced records</a><button type="button" class="fd-button fd-button--ghost" data-action="close-staff">Close</button><button type="button" class="fd-button fd-button--primary" data-action="logout">Sign out</button></div>`}</section></div>`;
}

function shell() {
  const hasSelection = Boolean(currentConversation());
  return `<div class="fd-shell ${hasSelection ? "fd-shell--conversation" : ""}">${topbar()}<main class="fd-layout">${inbox()}${workspace()}${contextPanel()}</main>${state.notice ? `<div class="fd-notice fd-notice--${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}${detailsDrawer()}${staffModal()}</div>`;
}

function render() {
  if (state.loading) {
    root.innerHTML = loadingView();
    return;
  }
  if (!state.staff) {
    root.innerHTML = loginView();
    return;
  }
  root.innerHTML = shell();
  if (state.scrollThreadOnRender) {
    const thread = root.querySelector("[data-thread]");
    if (thread instanceof HTMLElement) {
      requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
    }
    state.scrollThreadOnRender = false;
  }
}

function updateInboxOnly() {
  const list = root.querySelector("[data-inbox-list]");
  if (list instanceof HTMLElement) list.innerHTML = inboxList();
}

async function loadConversation(conversation, { showSpinner = true } = {}) {
  if (showSpinner) {
    state.loadingConversation = true;
    state.detail = null;
    render();
  }
  try {
    const [detailResult, contextResult] = await Promise.all([
      request(`/api/command-centre/conversation?id=${encodeURIComponent(conversation.id)}`),
      request(`/api/command-centre/client-context?id=${encodeURIComponent(conversation.id)}`).catch(() => ({ bookings: [] })),
    ]);
    state.detail = {
      ...(detailResult.detail ?? {}),
      bookings: Array.isArray(contextResult.bookings) ? contextResult.bookings : [],
    };
    const candidate = candidateForConversation(conversation.id);
    if (candidate && !state.draftDirty) {
      state.draft = candidate.candidateText;
      state.originalDraft = candidate.candidateText;
      state.draftDirty = false;
    }
    state.scrollThreadOnRender = true;
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "The conversation could not be loaded.", "error");
  } finally {
    state.loadingConversation = false;
    render();
  }
}

async function selectConversation(conversationId) {
  if (state.draftDirty && state.selectedConversationId !== conversationId && !window.confirm("Discard your unsent edits and open another conversation?")) return;
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  state.selectedConversationId = conversation.id;
  state.detailsOpen = false;
  state.draftDirty = false;
  state.noteDraft = "";
  const candidate = candidateForConversation(conversation.id);
  state.draft = candidate?.candidateText ?? "";
  state.originalDraft = candidate?.candidateText ?? "";
  await loadConversation(conversation);
}

async function loadWorkspace({ keepSelection = true, refreshDetail = true } = {}) {
  const previousId = keepSelection ? state.selectedConversationId : null;
  const [conversationResult, queueResult] = await Promise.all([
    request("/api/command-centre/conversations?limit=300"),
    request("/api/command-centre/receptionist-queue?limit=100"),
  ]);
  state.conversations = Array.isArray(conversationResult.conversations) ? conversationResult.conversations : [];
  state.queueItems = Array.isArray(queueResult.items) ? queueResult.items : [];
  state.deliveryEnabled = queueResult.deliveryEnabled === true && state.staff?.role !== "auditor";
  state.lastSyncedAt = new Date();

  const compactScreen = window.matchMedia("(max-width: 760px)").matches;
  let selected = state.conversations.find((conversation) => conversation.id === previousId);
  if (!selected && !compactScreen) selected = visibleConversations()[0] ?? state.conversations[0] ?? null;
  if (!selected) {
    state.selectedConversationId = null;
    state.detail = null;
    state.draft = "";
    state.originalDraft = "";
    state.draftDirty = false;
    return;
  }

  const changed = selected.id !== state.selectedConversationId;
  state.selectedConversationId = selected.id;
  const candidate = candidateForConversation(selected.id);
  if (changed || !state.draftDirty) {
    state.draft = candidate?.candidateText ?? "";
    state.originalDraft = candidate?.candidateText ?? "";
    state.draftDirty = false;
  }
  if (refreshDetail || changed || !state.detail) {
    await loadConversation(selected, { showSpinner: changed || !state.detail });
  }
}

async function start() {
  render();
  try {
    const session = await request("/api/command-centre/auth/session");
    state.staff = session.authenticated && session.staff ? session.staff : null;
    state.loading = false;
    if (state.staff) await loadWorkspace({ keepSelection: false });
  } catch {
    state.staff = null;
    state.loading = false;
  }
  render();
}

async function sendCurrent() {
  const conversation = currentConversation();
  const candidate = currentCandidate();
  if (!conversation || !candidate || !state.draft.trim()) return;
  if (!window.confirm(`Send this reply to ${conversation.clientDisplayName} from Tanglin WhatsApp?`)) return;
  state.busy = "send";
  render();
  try {
    const result = await request("/api/command-centre/receptionist-message", {
      method: "POST",
      body: JSON.stringify({
        action: "send",
        candidateId: candidate.candidateId,
        expectedSourceMessageId: candidate.sourceMessageId,
        expectedCandidateHash: candidate.responseHash,
        expectedPhoneEnding: candidate.phoneEnding,
        messageText: state.draft,
      }),
    });
    const edited = result.editedByHuman === true || state.draftDirty;
    state.busy = null;
    setNotice(edited ? `Edited reply sent to ${conversation.clientDisplayName} from Tanglin WhatsApp.` : `AI reply sent to ${conversation.clientDisplayName} from Tanglin WhatsApp.`);
    await loadWorkspace({ keepSelection: false });
  } catch (error) {
    state.busy = null;
    setNotice(error instanceof Error ? error.message : "The reply could not be sent.", "error");
    await loadWorkspace().catch(() => undefined);
  }
  render();
}

async function regenerateCurrent() {
  const candidate = currentCandidate();
  if (!candidate) return;
  if (state.draftDirty && !window.confirm("Create a new AI draft and discard your current edits?")) return;
  state.busy = "regenerate";
  render();
  try {
    const result = await request("/api/command-centre/receptionist-regenerate", {
      method: "POST",
      body: JSON.stringify({
        candidateId: candidate.candidateId,
        expectedSourceMessageId: candidate.sourceMessageId,
        expectedCandidateHash: candidate.responseHash,
        expectedPhoneEnding: candidate.phoneEnding,
      }),
    });
    state.busy = null;
    if (result.item) {
      state.queueItems = [result.item, ...state.queueItems.filter((entry) => entry.candidateId !== candidate.candidateId && entry.candidateId !== result.item.candidateId)];
      state.draft = result.item.candidateText;
      state.originalDraft = result.item.candidateText;
      state.draftDirty = false;
      const conversation = currentConversation();
      if (conversation) await loadConversation(conversation, { showSpinner: false });
    } else {
      await loadWorkspace();
    }
    setNotice(result.state === "regeneration_pending" ? "A new AI reply is still being prepared." : result.state === "original_restored" ? "The new reply could not be completed, so the original draft was restored." : "A new AI reply is ready.", result.state === "original_restored" ? "error" : "success");
  } catch (error) {
    state.busy = null;
    setNotice(error instanceof Error ? error.message : "A new reply could not be generated.", "error");
  }
  render();
}

async function takeOverCurrent() {
  const conversation = currentConversation();
  if (!conversation) return;
  if (!window.confirm("Move this conversation to human handling? The AI will pause and nothing will be sent.")) return;
  state.busy = "takeover";
  render();
  try {
    const candidate = currentCandidate();
    if (candidate) {
      await request("/api/command-centre/receptionist-message", {
        method: "POST",
        body: JSON.stringify({
          action: "hold",
          candidateId: candidate.candidateId,
          expectedSourceMessageId: candidate.sourceMessageId,
          expectedCandidateHash: candidate.responseHash,
          expectedPhoneEnding: candidate.phoneEnding,
        }),
      });
    } else {
      await request("/api/command-centre/conversation", {
        method: "POST",
        body: JSON.stringify({ action: "takeover", conversationId: conversation.id, reason: "Front desk selected Take Over / Hold in Hera Reception Desk.", takeoverUntil: null }),
      });
    }
    state.busy = null;
    setNotice("Conversation moved to human handling. Nothing was sent.");
    await loadWorkspace();
  } catch (error) {
    state.busy = null;
    setNotice(error instanceof Error ? error.message : "The conversation could not be held.", "error");
  }
  render();
}

async function returnCurrentToAi() {
  const conversation = currentConversation();
  if (!conversation) return;
  state.busy = "return-ai";
  render();
  try {
    await request("/api/command-centre/conversation", {
      method: "POST",
      body: JSON.stringify({ action: "return_to_ai", conversationId: conversation.id, reason: "Front desk completed human handling and returned the conversation to AI." }),
    });
    state.busy = null;
    setNotice("Conversation returned to AI-assisted handling.");
    await loadWorkspace();
  } catch (error) {
    state.busy = null;
    setNotice(error instanceof Error ? error.message : "The conversation could not be returned to AI.", "error");
  }
  render();
}

async function addInternalNote() {
  const conversation = currentConversation();
  const note = state.noteDraft.trim();
  if (!conversation || !note) return;
  state.busy = "note";
  render();
  try {
    await request("/api/command-centre/conversation", {
      method: "POST",
      body: JSON.stringify({ action: "add_note", conversationId: conversation.id, taskId: null, note }),
    });
    state.noteDraft = "";
    state.busy = null;
    setNotice("Internal note added. It was not sent to the client.");
    await loadConversation(conversation, { showSpinner: false });
  } catch (error) {
    state.busy = null;
    setNotice(error instanceof Error ? error.message : "The note could not be saved.", "error");
  }
  render();
}

root.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.id === "reception-draft") {
    state.draft = target.value;
    state.draftDirty = target.value !== state.originalDraft;
    const draftState = root.querySelector(".fd-draft-state");
    if (draftState instanceof HTMLElement) {
      draftState.classList.toggle("fd-draft-state--edited", state.draftDirty);
      draftState.innerHTML = `${state.draftDirty ? "Edited by you — the exact text above will be sent." : "AI draft ready for human review."}<span>${state.draft.length}/4000</span>`;
    }
    const send = root.querySelector('[data-action="send"]');
    if (send instanceof HTMLButtonElement) send.disabled = !state.deliveryEnabled || Boolean(state.busy) || !state.draft.trim();
    return;
  }
  if (target instanceof HTMLTextAreaElement && target.id === "internal-note") {
    state.noteDraft = target.value;
    const button = root.querySelector('[data-form="note"] button[type="submit"]');
    if (button instanceof HTMLButtonElement) button.disabled = Boolean(state.busy) || !state.noteDraft.trim();
    return;
  }
  if (target instanceof HTMLInputElement && target.matches("[data-search-input]")) {
    state.search = target.value;
    updateInboxOnly();
  }
});

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  const action = target?.getAttribute("data-action");
  if (!action) return;
  if (action === "select-conversation") {
    void selectConversation(target.getAttribute("data-conversation-id") || "");
  } else if (action === "filter") {
    const filter = target.getAttribute("data-filter");
    if (filter && FILTERS.includes(filter)) { state.filter = filter; render(); }
  } else if (action === "clear-search") {
    state.search = ""; render();
    const search = root.querySelector("[data-search-input]");
    if (search instanceof HTMLInputElement) search.focus();
  } else if (action === "back") {
    if (state.draftDirty && !window.confirm("Discard your unsent edits and return to the inbox?")) return;
    state.selectedConversationId = null; state.detail = null; state.draft = ""; state.originalDraft = ""; state.draftDirty = false; state.detailsOpen = false; state.noteDraft = ""; render();
  } else if (action === "refresh") {
    if (state.busy) return;
    state.busy = "refresh"; render();
    void loadWorkspace().then(() => setNotice("Inbox refreshed.")).catch((error) => setNotice(error instanceof Error ? error.message : "Refresh failed.", "error")).finally(() => { state.busy = null; render(); });
  } else if (action === "send") {
    void sendCurrent();
  } else if (action === "regenerate") {
    void regenerateCurrent();
  } else if (action === "takeover") {
    void takeOverCurrent();
  } else if (action === "return-ai") {
    void returnCurrentToAi();
  } else if (action === "open-details") {
    state.detailsOpen = true; render();
  } else if (action === "close-details") {
    state.detailsOpen = false; render();
  } else if (action === "toggle-message") {
    const messageId = target.getAttribute("data-message-id");
    if (!messageId) return;
    if (state.expandedMessages.has(messageId)) state.expandedMessages.delete(messageId); else state.expandedMessages.add(messageId);
    render();
  } else if (action === "staff") {
    state.staffOpen = true; render();
  } else if (action === "close-staff") {
    state.staffOpen = false; render();
  } else if (action === "logout") {
    state.busy = "logout";
    void request("/api/command-centre/auth/logout", { method: "POST", body: "{}" }).finally(() => window.location.reload());
  }
});

root.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const formType = form.dataset.form;
  if (formType === "note") {
    event.preventDefault();
    void addInternalNote();
    return;
  }
  if (formType !== "login" && formType !== "staff-login") return;
  event.preventDefault();
  const data = new FormData(form);
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  state.busy = "login"; render();
  void request("/api/command-centre/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })
    .then(() => window.location.reload())
    .catch((error) => { state.busy = null; state.staffOpen = formType === "staff-login"; setNotice(error instanceof Error ? error.message : "Sign-in failed.", "error"); });
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.detailsOpen) { state.detailsOpen = false; render(); }
  else if (state.staffOpen) { state.staffOpen = false; render(); }
});

window.setInterval(() => {
  if (document.visibilityState === "visible" && !state.busy && !state.draftDirty && state.staff) {
    void loadWorkspace({ refreshDetail: true }).then(() => render()).catch(() => undefined);
  }
}, 20_000);

void start();
