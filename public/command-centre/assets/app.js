import { commandApi } from "./api.js";
const rootElement = document.querySelector("#app");
if (!rootElement)
    throw new Error("Command centre root element was not found");
const root = rootElement;
const state = {
    staff: null,
    view: "overview",
    dashboard: null,
    tasks: [],
    conversations: [],
    selected: null,
    taskFilter: "open",
    conversationSearch: "",
    noteDrafts: {},
    busy: false,
    loadingView: true,
    notice: null,
};
const viewLabels = {
    overview: "Overview",
    tasks: "Human Action",
    conversations: "Conversations",
    quality: "Quality",
    audit: "Audit",
    settings: "Controls",
};
const taskLabels = {
    booking_action: "Booking confirmation",
    appointment_change: "Appointment change",
    arrival_issue: "Arrival issue",
    group_booking: "Group booking",
    complaint_review: "Complaint review",
    refund_finance: "Refund or finance",
    medical_safety: "Medical safety",
    technical_review: "Technical review",
    privacy_legal: "Privacy or legal",
    accessibility_arrangement: "Accessibility arrangement",
    consent_media: "Consent or media",
    lost_property: "Lost property",
    client_requested_human: "Human requested",
    security_review: "Security review",
    system_failure: "System failure",
    other: "Other action",
};
function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
function humanize(value) {
    return value
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
function formatDate(value) {
    if (!value)
        return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return "—";
    return new Intl.DateTimeFormat("en-SG", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}
function timeAgo(value) {
    const time = Date.parse(value);
    if (!Number.isFinite(time))
        return "—";
    const seconds = Math.round((Date.now() - time) / 1000);
    if (seconds < 60)
        return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
function priorityIcon(priority) {
    return priority === "emergency" ? "◆" : priority === "urgent" ? "▲" : priority === "high" ? "●" : "○";
}
function taskBadge(task) {
    const classes = ["pill", `pill--${escapeHtml(task.priority)}`];
    if (task.overdue)
        classes.push("pill--overdue");
    return `<span class="${classes.join(" ")}">${priorityIcon(task.priority)} ${task.overdue ? "Overdue" : humanize(task.priority)}</span>`;
}
function riskBadge(risk) {
    return `<span class="risk risk--${escapeHtml(risk)}"><span class="risk__dot"></span>${humanize(risk)}</span>`;
}
function modeBadge(mode) {
    return mode === "management"
        ? '<span class="mode mode--human">Human handling</span>'
        : '<span class="mode mode--ai">AI handling</span>';
}
function roleLabel(role) {
    const labels = {
        owner: "Owner",
        managing_director: "Managing Director",
        salon_manager: "Salon Manager",
        receptionist: "Receptionist",
        technical_lead: "Technical Lead",
        finance_admin: "Finance & Administration",
        privacy_officer: "Privacy & Legal",
        auditor: "Auditor",
    };
    return labels[role] ?? humanize(role);
}
const receptionTaskTypes = new Set([
    "booking_action",
    "appointment_change",
    "arrival_issue",
    "group_booking",
    "accessibility_arrangement",
    "lost_property",
    "client_requested_human",
    "other",
]);
const technicalTaskTypes = new Set(["technical_review", "medical_safety", "complaint_review"]);
const privacyTaskTypes = new Set(["privacy_legal", "consent_media", "security_review"]);
function canAcceptTask(task) {
    const role = state.staff?.role ?? "auditor";
    if (role === "owner" || role === "managing_director")
        return true;
    if (role === "salon_manager")
        return !privacyTaskTypes.has(task.taskType);
    if (role === "receptionist")
        return receptionTaskTypes.has(task.taskType);
    if (role === "technical_lead")
        return technicalTaskTypes.has(task.taskType);
    if (role === "finance_admin")
        return task.taskType === "refund_finance";
    if (role === "privacy_officer")
        return privacyTaskTypes.has(task.taskType);
    return false;
}
function canTransitionTask(task) {
    const role = state.staff?.role ?? "auditor";
    if (["owner", "managing_director", "salon_manager"].includes(role))
        return true;
    return Boolean(state.staff && task.ownerUserId === state.staff.userId && canAcceptTask(task));
}
function canControlConversation() {
    return [
        "owner",
        "managing_director",
        "salon_manager",
        "receptionist",
        "technical_lead",
        "privacy_officer",
    ].includes(state.staff?.role ?? "");
}
function canAddInternalNote() {
    return state.staff?.role !== "auditor";
}
function setNotice(type, message) {
    state.notice = { type, message };
    render();
    window.setTimeout(() => {
        if (state.notice?.message === message) {
            state.notice = null;
            render();
        }
    }, 5000);
}
function noticeHtml() {
    if (!state.notice)
        return "";
    return `<div class="toast toast--${state.notice.type}" role="status">
    <span>${escapeHtml(state.notice.message)}</span>
    <button type="button" class="toast__close" data-action="dismiss-notice" aria-label="Dismiss">×</button>
  </div>`;
}
function loadingBlock(label = "Loading command centre") {
    return `<div class="loading-card" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span>${escapeHtml(label)}</span>
  </div>`;
}
function emptyState(title, body) {
    return `<div class="empty-state">
    <div class="empty-state__mark">H</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
  </div>`;
}
function renderLogin() {
    return `<main class="login-shell">
    <section class="login-brand" aria-label="Hera AI Command Centre">
      <div class="brand-mark brand-mark--large">H</div>
      <p class="eyebrow">Hera Hair Beauty</p>
      <h1>AI Command Centre</h1>
      <p class="login-brand__lead">One calm, secure place to supervise AI conversations, human actions, service recovery and operational records.</p>
      <div class="login-assurance">
        <div><strong>Shadow protected</strong><span>No AI-generated client sends are enabled.</span></div>
        <div><strong>Audited control</strong><span>Every operator action is recorded.</span></div>
        <div><strong>Human authority</strong><span>Bookings, complaints and sensitive actions remain controlled.</span></div>
      </div>
    </section>
    <section class="login-panel">
      <form class="login-card" id="login-form" autocomplete="on">
        <div class="login-card__header">
          <p class="eyebrow">Private staff access</p>
          <h2>Welcome back</h2>
          <p>Sign in with your authorised Hera Command Centre account.</p>
        </div>
        <label class="field">
          <span>Email address</span>
          <input type="email" name="email" required autocomplete="username" maxlength="320" placeholder="name@herabeauty.sg">
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" required autocomplete="current-password" minlength="12" maxlength="256" placeholder="Your secure password">
        </label>
        <button type="submit" class="button button--primary button--full" ${state.busy ? "disabled" : ""}>
          ${state.busy ? '<span class="spinner spinner--small"></span> Signing in' : "Sign in securely"}
        </button>
        <p class="login-card__fineprint">Access is restricted to authorised Hera staff. Failed and successful access attempts are monitored.</p>
      </form>
    </section>
    ${noticeHtml()}
  </main>`;
}
function navButton(view, icon) {
    const active = state.view === view;
    return `<button type="button" class="nav-item ${active ? "nav-item--active" : ""}" data-view="${view}" aria-current="${active ? "page" : "false"}">
    <span class="nav-item__icon" aria-hidden="true">${icon}</span>
    <span>${viewLabels[view]}</span>
  </button>`;
}
function shell() {
    const staff = state.staff;
    if (!staff)
        return renderLogin();
    return `<div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar__brand">
        <div class="brand-mark">H</div>
        <div><strong>Hera AI</strong><span>Command Centre</span></div>
      </div>
      <nav class="sidebar__nav" aria-label="Command centre navigation">
        ${navButton("overview", "⌂")}
        ${navButton("tasks", "✓")}
        ${navButton("conversations", "◫")}
        ${navButton("quality", "◇")}
        ${navButton("audit", "≡")}
        ${navButton("settings", "⚙")}
      </nav>
      <div class="sidebar__safety">
        <span class="safety-dot"></span>
        <div><strong>AI delivery</strong><span>${state.dashboard?.mode === "live" ? "Live mode" : "Shadow mode"}</span></div>
      </div>
      <div class="sidebar__user">
        <div class="avatar">${escapeHtml(staff.displayName.slice(0, 1).toUpperCase())}</div>
        <div class="sidebar__user-copy"><strong>${escapeHtml(staff.displayName)}</strong><span>${escapeHtml(roleLabel(staff.role))}</span></div>
        <button type="button" class="icon-button" data-action="logout" aria-label="Sign out">↗</button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Hera operations</p>
          <h1>${escapeHtml(viewLabels[state.view])}</h1>
        </div>
        <div class="topbar__actions">
          <div class="environment-badge ${state.dashboard?.mode === "live" ? "environment-badge--live" : ""}">
            <span></span>${state.dashboard?.mode === "live" ? "Live delivery" : "Shadow protected"}
          </div>
          <button type="button" class="button button--secondary" data-action="refresh">Refresh</button>
        </div>
      </header>
      <main class="content" id="main-content">
        ${state.loadingView ? loadingBlock() : renderView()}
      </main>
    </div>
    ${state.selected ? renderConversationDrawer(state.selected) : ""}
    ${noticeHtml()}
  </div>`;
}
function metricCard(label, value, note, tone = "neutral") {
    return `<article class="metric-card metric-card--${tone}">
    <div class="metric-card__top"><span>${escapeHtml(label)}</span><span class="metric-card__spark"></span></div>
    <strong>${value.toLocaleString("en-SG")}</strong>
    <p>${escapeHtml(note)}</p>
  </article>`;
}
function renderOverview() {
    const dashboard = state.dashboard;
    if (!dashboard)
        return emptyState("No operational snapshot", "Refresh to load the latest command centre state.");
    const safetyTone = dashboard.readiness === "healthy" ? "success" : dashboard.readiness === "attention" ? "attention" : "danger";
    return `<section class="stack stack--large">
    <div class="hero-status hero-status--${safetyTone}">
      <div>
        <p class="eyebrow">Operational state</p>
        <h2>${dashboard.readiness === "healthy" ? "All protected systems are orderly" : dashboard.readiness === "attention" ? "Attention is required" : "Critical action is required"}</h2>
        <p>${dashboard.mode === "shadow" ? "AI reasoning is active while all AI-generated client replies remain unsent." : "Live delivery is active. Every action must be monitored continuously."}</p>
      </div>
      <div class="hero-status__stamp"><span>${dashboard.readiness === "healthy" ? "✓" : "!"}</span><small>${formatDate(dashboard.generatedAt)}</small></div>
    </div>
    <div class="metric-grid">
      ${metricCard("Needs human action", dashboard.counts.needsAction, dashboard.counts.overdueTasks ? `${dashboard.counts.overdueTasks} overdue` : "No overdue tasks", dashboard.counts.overdueTasks ? "danger" : "neutral")}
      ${metricCard("Human handling", dashboard.counts.humanHandling, "AI is paused in these conversations", "attention")}
      ${metricCard("AI handling", dashboard.counts.aiHandling, "Protected by verifier and policy", "success")}
      ${metricCard("Provider sends", dashboard.counts.providerSends, dashboard.counts.providerSends === 0 ? "No AI-generated messages sent" : "Review immediately", dashboard.counts.providerSends === 0 ? "success" : "danger")}
    </div>
    <div class="two-column">
      <section class="panel">
        <div class="panel__header">
          <div><p class="eyebrow">Priority queue</p><h2>Needs human action</h2></div>
          <button type="button" class="text-button" data-view="tasks">View all</button>
        </div>
        <div class="queue-list">
          ${dashboard.priorityTasks.length ? dashboard.priorityTasks.slice(0, 6).map(taskRow).join("") : emptyState("No tasks waiting", "New handoffs will appear here with an owner, deadline and required action.")}
        </div>
      </section>
      <section class="panel">
        <div class="panel__header">
          <div><p class="eyebrow">Live inbox</p><h2>Recent conversations</h2></div>
          <button type="button" class="text-button" data-view="conversations">View all</button>
        </div>
        <div class="conversation-list conversation-list--compact">
          ${dashboard.recentConversations.length ? dashboard.recentConversations.slice(0, 7).map(conversationRow).join("") : emptyState("No recent conversations", "Incoming WhatsApp conversations will appear here.")}
        </div>
      </section>
    </div>
    <div class="three-column">
      <section class="panel panel--compact">
        <p class="eyebrow">Queue integrity</p>
        <h3>${dashboard.counts.activeJobs + dashboard.counts.activeOutbox === 0 ? "Clear" : "Processing"}</h3>
        <dl class="mini-stats"><div><dt>Active jobs</dt><dd>${dashboard.counts.activeJobs}</dd></div><div><dt>Dead jobs</dt><dd>${dashboard.counts.deadJobs}</dd></div><div><dt>Active outbox</dt><dd>${dashboard.counts.activeOutbox}</dd></div></dl>
      </section>
      <section class="panel panel--compact">
        <p class="eyebrow">Safety & incidents</p>
        <h3>${dashboard.counts.openIncidents === 0 ? "No open incidents" : `${dashboard.counts.openIncidents} open`}</h3>
        <dl class="mini-stats"><div><dt>Critical</dt><dd>${dashboard.counts.criticalIncidents}</dd></div><div><dt>Waiting client</dt><dd>${dashboard.counts.waitingClient}</dd></div><div><dt>Waiting internal</dt><dd>${dashboard.counts.waitingInternal}</dd></div></dl>
      </section>
      <section class="panel panel--compact">
        <p class="eyebrow">Human quality evidence</p>
        <h3>${dashboard.quality.humanReviewedCases} reviewed</h3>
        <dl class="mini-stats"><div><dt>Pass</dt><dd>${dashboard.quality.passCases}</dd></div><div><dt>Needs review</dt><dd>${dashboard.quality.needsReviewCases}</dd></div><div><dt>Fail</dt><dd>${dashboard.quality.failCases}</dd></div></dl>
      </section>
    </div>
  </section>`;
}
function taskRow(task) {
    return `<button type="button" class="queue-row" data-conversation-id="${escapeHtml(task.conversationId)}">
    <div class="queue-row__priority priority-dot priority-dot--${escapeHtml(task.priority)}"></div>
    <div class="queue-row__main">
      <div class="queue-row__title"><strong>${escapeHtml(task.clientDisplayName)}</strong><span>•••• ${escapeHtml(task.phoneEnding)}</span></div>
      <p>${escapeHtml(task.summary)}</p>
      <small>${escapeHtml(taskLabels[task.taskType] ?? humanize(task.taskType))} · ${timeAgo(task.lastMessageAt)}</small>
    </div>
    <div class="queue-row__status">${taskBadge(task)}<span>${task.dueAt ? `Due ${formatDate(task.dueAt)}` : "No deadline"}</span></div>
  </button>`;
}
function renderTasks() {
    const visible = state.tasks.filter((task) => state.taskFilter === "all" || state.taskFilter === "open" || task.status === state.taskFilter);
    return `<section class="stack">
    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="Task filter">
        ${["open", "new", "accepted", "waiting_client", "waiting_internal", "resolved", "all"].map((filter) => `<button type="button" class="${state.taskFilter === filter ? "active" : ""}" data-task-filter="${filter}">${humanize(filter)}</button>`).join("")}
      </div>
      <div class="toolbar__summary"><strong>${visible.length}</strong><span>tasks shown</span></div>
    </div>
    <div class="task-board">
      ${visible.length ? visible.map(taskCard).join("") : emptyState("No tasks in this queue", "The queue is orderly. Change the filter to view completed records.")}
    </div>
  </section>`;
}
function taskCard(task) {
    const canAccept = (task.status === "new" || task.status === "assigned") && canAcceptTask(task);
    const canResolve = ["accepted", "waiting_client", "waiting_internal"].includes(task.status) && canTransitionTask(task);
    return `<article class="task-card ${task.overdue ? "task-card--overdue" : ""}">
    <div class="task-card__header">
      <div>${taskBadge(task)}<span class="scope-tag">${humanize(task.scope)}</span></div>
      <span class="task-id">#${escapeHtml(task.id.slice(0, 8))}</span>
    </div>
    <button type="button" class="task-card__client" data-conversation-id="${escapeHtml(task.conversationId)}">
      <span class="avatar avatar--client">${escapeHtml(task.clientDisplayName.slice(0, 1).toUpperCase())}</span>
      <span><strong>${escapeHtml(task.clientDisplayName)}</strong><small>WhatsApp ending ${escapeHtml(task.phoneEnding)} · ${riskBadge(task.conversationRisk)}</small></span>
    </button>
    <div class="task-card__body">
      <p class="eyebrow">${escapeHtml(taskLabels[task.taskType] ?? humanize(task.taskType))}</p>
      <h3>${escapeHtml(task.summary)}</h3>
      <p>${escapeHtml(task.requestedAction)}</p>
    </div>
    <dl class="task-meta">
      <div><dt>Status</dt><dd>${humanize(task.status)}</dd></div>
      <div><dt>Owner</dt><dd>${escapeHtml(task.ownerDisplayName ?? "Unassigned")}</dd></div>
      <div><dt>Outlet</dt><dd>${escapeHtml(task.assignedOutlet ?? "Not set")}</dd></div>
      <div><dt>Due</dt><dd>${task.dueAt ? formatDate(task.dueAt) : "Not set"}</dd></div>
    </dl>
    <div class="task-card__footer">
      <button type="button" class="button button--secondary" data-conversation-id="${escapeHtml(task.conversationId)}">Open conversation</button>
      ${canAccept ? `<button type="button" class="button button--primary" data-action="accept-task" data-task-id="${escapeHtml(task.id)}" data-version="${task.version}">Accept task</button>` : ""}
      ${canResolve ? `<button type="button" class="button button--quiet" data-action="resolve-task" data-task-id="${escapeHtml(task.id)}" data-version="${task.version}">Mark resolved</button>` : ""}
    </div>
  </article>`;
}
function conversationRow(conversation) {
    return `<button type="button" class="conversation-row" data-conversation-id="${escapeHtml(conversation.id)}">
    <span class="avatar avatar--client">${escapeHtml(conversation.clientDisplayName.slice(0, 1).toUpperCase())}</span>
    <span class="conversation-row__body"><span><strong>${escapeHtml(conversation.clientDisplayName)}</strong><small>${timeAgo(conversation.lastMessageAt)}</small></span><p>${escapeHtml(conversation.lastMessagePreview || "No message preview")}</p><small>${modeBadge(conversation.operatingMode)} ${riskBadge(conversation.currentRisk)} ${conversation.openTaskCount ? `<span class="task-count">${conversation.openTaskCount} open task${conversation.openTaskCount === 1 ? "" : "s"}</span>` : ""}</small></span>
  </button>`;
}
function renderConversations() {
    return `<section class="stack">
    <div class="toolbar toolbar--search">
      <label class="search-box"><span aria-hidden="true">⌕</span><input type="search" id="conversation-search" value="${escapeHtml(state.conversationSearch)}" placeholder="Search name, last four digits or message" aria-label="Search conversations"></label>
      <div class="toolbar__summary"><strong>${state.conversations.length}</strong><span>conversations</span></div>
    </div>
    <section class="panel panel--flush">
      <div class="conversation-list">
        ${state.conversations.length ? state.conversations.map(conversationRow).join("") : emptyState("No matching conversations", "Try a different search or refresh the inbox.")}
      </div>
    </section>
  </section>`;
}
function renderQuality() {
    const quality = state.dashboard?.quality;
    if (!quality)
        return emptyState("Quality evidence unavailable", "Refresh the command centre to load the latest evidence.");
    const reviewed = quality.humanReviewedCases;
    return `<section class="stack stack--large">
    <div class="metric-grid">
      ${metricCard("Eligible shadow cases", quality.eligibleCases, "Preserved for review")}
      ${metricCard("Human reviewed", reviewed, "Named staff reviews only", "attention")}
      ${metricCard("Launch-metric passes", quality.passCases, `${quality.passRate.toFixed(1)}% pass rate`, quality.passCases ? "success" : "neutral")}
      ${metricCard("Needs review or fail", quality.needsReviewCases + quality.failCases, "Every weakness remains preserved", quality.failCases ? "danger" : "attention")}
    </div>
    <section class="panel quality-principles">
      <div class="panel__header"><div><p class="eyebrow">Hera quality gate</p><h2>What counts as launch-quality</h2></div></div>
      <div class="principle-grid">
        <article><span>01</span><h3>Accurate</h3><p>No invented availability, pricing, policy or booking completion.</p></article>
        <article><span>02</span><h3>Safe</h3><p>Medical, chemical and privacy risks are contained before convenience.</p></article>
        <article><span>03</span><h3>Effortless</h3><p>The client is not made to repeat details or navigate unnecessary steps.</p></article>
        <article><span>04</span><h3>Hera-standard</h3><p>Warm ownership, clear action and composed luxury-hospitality tone.</p></article>
      </div>
    </section>
    <section class="panel">
      <div class="panel__header"><div><p class="eyebrow">Current evidence</p><h2>Human review position</h2></div></div>
      <div class="quality-bar"><span style="width:${Math.min(100, quality.passRate)}%"></span></div>
      <div class="quality-breakdown"><div><strong>${quality.passCases}</strong><span>Pass</span></div><div><strong>${quality.needsReviewCases}</strong><span>Needs review</span></div><div><strong>${quality.failCases}</strong><span>Fail</span></div><div><strong>${quality.launchMetricCases}</strong><span>Launch-metric cases</span></div></div>
      <p class="muted">Automated assessments and operational backfill records do not inflate Hera's human launch evidence.</p>
    </section>
  </section>`;
}
function renderAudit() {
    const events = state.dashboard?.recentAudit ?? [];
    return `<section class="panel panel--flush">
    <div class="panel__header panel__header--padded"><div><p class="eyebrow">Immutable trail</p><h2>Recent command and system activity</h2></div></div>
    <div class="audit-table" role="table" aria-label="Recent audit events">
      <div class="audit-table__head" role="row"><span>Time</span><span>Event</span><span>Target</span><span>Actor</span></div>
      ${events.length ? events.map((event) => `<div class="audit-table__row" role="row"><span>${formatDate(event.createdAt)}</span><strong>${escapeHtml(humanize(event.eventType))}</strong><span>${escapeHtml(humanize(event.targetType))}</span><span>${escapeHtml(event.actorId ?? "System")}</span></div>`).join("") : emptyState("No recent audit events", "Operator and system actions will be retained here.")}
    </div>
  </section>`;
}
function renderSettings() {
    const dashboard = state.dashboard;
    return `<section class="stack stack--large">
    <div class="control-banner">
      <div><p class="eyebrow">Non-negotiable safety state</p><h2>${dashboard?.mode === "live" ? "Live delivery is active" : "Shadow mode is locked"}</h2><p>${dashboard?.mode === "live" ? "Live mode requires continuous monitoring and independent confirmation." : "AI can reason, verify and prepare replies, but no AI-generated client message is delivered."}</p></div>
      <span class="control-banner__status">${dashboard?.mode === "live" ? "LIVE" : "SHADOW"}</span>
    </div>
    <div class="two-column">
      <section class="panel">
        <div class="panel__header"><div><p class="eyebrow">Conversation authority</p><h2>Human takeover controls</h2></div></div>
        <div class="control-list">
          <div><span class="control-icon">1</span><div><strong>Task-only action</strong><p>Staff completes a booking, finance or operational action while AI may answer unrelated safe questions.</p></div></div>
          <div><span class="control-icon">2</span><div><strong>Full conversation takeover</strong><p>AI pauses until staff explicitly resolves and returns the conversation.</p></div></div>
          <div><span class="control-icon">3</span><div><strong>Emergency handling</strong><p>Immediate safety guidance is followed by urgent human action and locked management control.</p></div></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel__header"><div><p class="eyebrow">Preview boundary</p><h2>What is deliberately disabled</h2></div></div>
        <ul class="safety-list"><li>Sending human messages from this GUI</li><li>Changing WhatsApp delivery to live</li><li>Creating or changing Timely bookings</li><li>Approving refunds or compensation without authority</li><li>Displaying API keys, secrets or raw webhook payloads</li></ul>
      </section>
    </div>
    <section class="panel">
      <div class="panel__header"><div><p class="eyebrow">System integrity</p><h2>Protected queue state</h2></div></div>
      <div class="system-grid">
        <div><span>Active AI jobs</span><strong>${dashboard?.counts.activeJobs ?? 0}</strong></div>
        <div><span>Dead AI jobs</span><strong>${dashboard?.counts.deadJobs ?? 0}</strong></div>
        <div><span>Active outbox</span><strong>${dashboard?.counts.activeOutbox ?? 0}</strong></div>
        <div><span>Dead outbox</span><strong>${dashboard?.counts.deadOutbox ?? 0}</strong></div>
        <div><span>Open incidents</span><strong>${dashboard?.counts.openIncidents ?? 0}</strong></div>
        <div><span>Provider sends</span><strong>${dashboard?.counts.providerSends ?? 0}</strong></div>
      </div>
    </section>
  </section>`;
}
function renderView() {
    if (state.view === "overview")
        return renderOverview();
    if (state.view === "tasks")
        return renderTasks();
    if (state.view === "conversations")
        return renderConversations();
    if (state.view === "quality")
        return renderQuality();
    if (state.view === "audit")
        return renderAudit();
    return renderSettings();
}
function renderConversationDrawer(detail) {
    const conversation = detail.conversation;
    const activeTask = detail.tasks.find((task) => !["resolved", "cancelled"].includes(task.status));
    const latestCandidate = detail.candidates[0];
    const latestInbound = [...detail.messages].reverse().find((message) => message.direction === "inbound");
    const traceSourceMessageId = latestCandidate?.sourceMessageId ?? latestInbound?.id ?? null;
    const currentTrace = traceSourceMessageId
        ? detail.decisions.filter((decision) => decision.sourceMessageId === traceSourceMessageId)
        : [];
    const responseTrace = currentTrace.find((decision) => decision.stage === "response");
    const verificationTrace = currentTrace.find((decision) => decision.stage === "verification");
    const policyTrace = currentTrace.find((decision) => decision.stage === "policy");
    const policyOutput = record(policyTrace?.output);
    const finalVerification = record(policyOutput?.finalVerification);
    const finalQuality = record(policyOutput?.finalQuality);
    const draftFinalReply = typeof policyOutput?.draftFinalReply === "string" ? policyOutput.draftFinalReply : null;
    const finalReply = typeof policyOutput?.finalReply === "string" ? policyOutput.finalReply : latestCandidate?.text ?? null;
    const qualityIssues = stringArray(finalQuality?.issues);
    const deliveryEligible = policyOutput?.deliveryEligible === true;
    return `<div class="drawer-backdrop" data-action="close-drawer" aria-hidden="true"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Conversation with ${escapeHtml(conversation.clientDisplayName)}">
      <header class="drawer__header">
        <div class="drawer__client"><span class="avatar avatar--large">${escapeHtml(conversation.clientDisplayName.slice(0, 1).toUpperCase())}</span><div><p class="eyebrow">WhatsApp ending ${escapeHtml(conversation.phoneEnding)}</p><h2>${escapeHtml(conversation.clientDisplayName)}</h2><div>${modeBadge(conversation.operatingMode)} ${riskBadge(conversation.currentRisk)}</div></div></div>
        <button type="button" class="icon-button icon-button--large" data-action="close-drawer" aria-label="Close conversation">×</button>
      </header>
      <div class="drawer__body">
        <section class="conversation-summary">
          <div><p class="eyebrow">AI summary</p><h3>${activeTask ? escapeHtml(activeTask.summary) : escapeHtml(conversation.lastMessagePreview || "Conversation ready for review")}</h3><p>${activeTask ? escapeHtml(activeTask.requestedAction) : "No open human-action task is currently attached."}</p></div>
          ${activeTask ? `<div class="summary-task">${taskBadge(activeTask)}<span>${escapeHtml(taskLabels[activeTask.taskType] ?? humanize(activeTask.taskType))}</span><strong>${escapeHtml(activeTask.ownerDisplayName ?? "Unassigned")}</strong></div>` : ""}
        </section>
        <div class="drawer-grid">
          <section class="transcript-panel">
            <div class="section-title"><div><p class="eyebrow">Conversation</p><h3>WhatsApp transcript</h3></div><span>${detail.messages.length} messages</span></div>
            <div class="transcript">
              ${detail.messages.length ? detail.messages.map((message) => `<div class="message message--${message.direction} ${message.aiGenerated ? "message--ai" : ""}"><div class="message__meta"><span>${message.direction === "inbound" ? conversation.clientDisplayName : message.aiGenerated ? "Hera AI candidate" : "Hera staff"}</span><time>${formatDate(message.providerTimestamp ?? message.createdAt)}</time></div><p>${escapeHtml(message.text || `[${humanize(message.kind)}]`)}</p><small>${escapeHtml(message.deliveryStatus)}</small></div>`).join("") : emptyState("No transcript", "Messages will appear here once received.")}
            </div>
          </section>
          <section class="action-panel">
            <div class="section-title"><div><p class="eyebrow">Control</p><h3>Human action</h3></div></div>
            <div class="action-panel__status">
              <span>Current mode</span>${modeBadge(conversation.operatingMode)}
              <p>${conversation.operatingMode === "management" ? "AI is paused for this conversation until staff returns it." : "AI may continue handling verified, low-risk questions."}</p>
            </div>
            <div class="button-stack">
              ${canControlConversation() ? (conversation.operatingMode === "ai" ? `<button type="button" class="button button--primary button--full" data-action="takeover" data-conversation-id="${escapeHtml(conversation.id)}">Take over conversation</button>` : `<button type="button" class="button button--primary button--full" data-action="return-ai" data-conversation-id="${escapeHtml(conversation.id)}">Resolve and return to AI</button>`) : `<p class="action-note">Your role has read-only conversation control.</p>`}
              ${activeTask && (activeTask.status === "new" || activeTask.status === "assigned") && canAcceptTask(activeTask) ? `<button type="button" class="button button--secondary button--full" data-action="accept-task" data-task-id="${escapeHtml(activeTask.id)}" data-version="${activeTask.version}">Accept human-action task</button>` : ""}
              <p class="action-note">Human WhatsApp replies remain in the normal WhatsApp Business App during this Preview stage.</p>
            </div>
${latestCandidate ? `<div class="candidate-card"><div><p class="eyebrow">Latest AI candidate</p><span class="pill">${escapeHtml(latestCandidate.status)}</span></div><p>${escapeHtml(latestCandidate.text)}</p><small>${latestCandidate.providerMessageId ? "Provider message exists" : "Not sent to WhatsApp"}</small></div>` : ""}
${policyTrace ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality</p><span class="pill ${deliveryEligible ? "pill--normal" : "pill--urgent"}">${deliveryEligible ? "Passed" : "Blocked"}</span></div>
  <dl class="task-meta">
    <div><dt>Primary model</dt><dd>${escapeHtml(responseTrace?.modelId ?? "Not recorded")}</dd></div>
    <div><dt>First verifier</dt><dd>${escapeHtml(verificationTrace?.modelId ?? "Not recorded")}</dd></div>
    <div><dt>Final verifier</dt><dd>${escapeHtml(String(finalVerification?.modelId ?? policyTrace.modelId ?? "Not recorded"))}</dd></div>
    <div><dt>Policy</dt><dd>${escapeHtml(policyTrace.policyVersion)}</dd></div>
  </dl>
  ${draftFinalReply ? `<p><strong>Post-policy draft</strong><br>${escapeHtml(draftFinalReply)}</p>` : ""}
  ${finalReply ? `<p><strong>Final client reply</strong><br>${escapeHtml(finalReply)}</p>` : ""}
  <small>${qualityIssues.length ? escapeHtml(qualityIssues.join(" · ")) : escapeHtml(String(finalVerification?.summary ?? "Final response passed every quality dimension."))}</small>
</div>` : ""}
            ${canAddInternalNote() ? `<form class="note-form" id="note-form" data-conversation-id="${escapeHtml(conversation.id)}" data-task-id="${escapeHtml(activeTask?.id ?? "")}">
              <label class="field"><span>Internal note</span><textarea name="note" rows="3" maxlength="4000" placeholder="Record a clear internal note. This is never sent to the client.">${escapeHtml(state.noteDrafts[conversation.id] ?? "")}</textarea></label>
              <button type="submit" class="button button--secondary button--full">Add internal note</button>
            </form>` : ""}
            ${detail.notes.length ? `<div class="notes-list"><p class="eyebrow">Recent notes</p>${detail.notes.slice(0, 6).map((note) => `<article><p>${escapeHtml(note.body)}</p><small>${escapeHtml(note.authorDisplayName)} · ${formatDate(note.createdAt)}</small></article>`).join("")}</div>` : ""}
          </section>
        </div>
      </div>
    </aside>`;
}
let renderGeneration = 0;
function captureDrawerRenderSnapshot() {
    const conversationId = state.selected?.conversation.id;
    if (!conversationId)
        return null;
    const drawerBody = root.querySelector(".drawer__body");
    const transcript = root.querySelector(".transcript");
    const note = root.querySelector('#note-form textarea[name="note"]');
    if (note)
        state.noteDrafts[conversationId] = note.value;
    return {
        conversationId,
        bodyScrollTop: drawerBody?.scrollTop ?? 0,
        transcriptScrollTop: transcript?.scrollTop ?? 0,
        noteFocused: document.activeElement === note,
        noteSelectionStart: note?.selectionStart ?? null,
        noteSelectionEnd: note?.selectionEnd ?? null,
    };
}
function restoreDrawerRenderSnapshot(snapshot) {
    if (state.selected?.conversation.id !== snapshot.conversationId)
        return;
    const drawerBody = root.querySelector(".drawer__body");
    const transcript = root.querySelector(".transcript");
    const note = root.querySelector('#note-form textarea[name="note"]');
    if (drawerBody)
        drawerBody.scrollTop = snapshot.bodyScrollTop;
    if (transcript)
        transcript.scrollTop = snapshot.transcriptScrollTop;
    if (note && snapshot.noteFocused) {
        note.focus({ preventScroll: true });
        if (snapshot.noteSelectionStart !== null &&
            snapshot.noteSelectionEnd !== null) {
            note.setSelectionRange(snapshot.noteSelectionStart, snapshot.noteSelectionEnd);
        }
    }
}
function render() {
    const snapshot = captureDrawerRenderSnapshot();
    const generation = ++renderGeneration;
    root.innerHTML = shell();
    if (!snapshot)
        return;
    window.requestAnimationFrame(() => {
        if (generation !== renderGeneration)
            return;
        restoreDrawerRenderSnapshot(snapshot);
    });
}
async function loadDashboard() {
    const result = await commandApi.dashboard();
    state.dashboard = result.dashboard;
}
async function loadView(view, force = false) {
    state.view = view;
    state.loadingView = true;
    render();
    try {
        if (view === "overview" || view === "quality" || view === "audit" || view === "settings" || force) {
            await loadDashboard();
        }
        if (view === "tasks") {
            const result = await commandApi.tasks(state.taskFilter);
            state.tasks = result.tasks;
        }
        if (view === "conversations") {
            const result = await commandApi.conversations(state.conversationSearch);
            state.conversations = result.conversations;
        }
    }
    catch (error) {
        if (error instanceof Error && error.name === "AuthenticationError") {
            state.staff = null;
            state.dashboard = null;
            state.selected = null;
            setNotice("info", "Your secure session ended. Please sign in again.");
            return;
        }
        setNotice("error", error instanceof Error ? error.message : "The view could not be loaded.");
    }
    finally {
        state.loadingView = false;
        render();
    }
}
async function openConversation(id) {
    state.busy = true;
    render();
    try {
        const result = await commandApi.conversation(id);
        state.selected = result.detail;
    }
    catch (error) {
        setNotice("error", error instanceof Error ? error.message : "The conversation could not be opened.");
    }
    finally {
        state.busy = false;
        render();
    }
}
async function refreshCurrent() {
    state.selected = null;
    await loadView(state.view, true);
}
root.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement))
        return;
    event.preventDefault();
    if (form.id === "login-form") {
        const data = new FormData(form);
        const email = String(data.get("email") ?? "");
        const password = String(data.get("password") ?? "");
        state.busy = true;
        render();
        void commandApi
            .login(email, password)
            .then(async (result) => {
            state.staff = result.staff;
            state.notice = null;
            await loadView("overview", true);
        })
            .catch((error) => {
            state.busy = false;
            setNotice("error", error instanceof Error ? error.message : "Sign-in failed.");
        });
        return;
    }
    if (form.id === "note-form") {
        const conversationId = form.dataset.conversationId ?? "";
        const taskId = form.dataset.taskId || null;
        const data = new FormData(form);
        const note = String(data.get("note") ?? "").trim();
        if (!note)
            return;
        state.busy = true;
        void commandApi
            .addNote(conversationId, note, taskId)
            .then(async () => {
            state.noteDrafts[conversationId] = "";
            const noteField = root.querySelector('#note-form textarea[name="note"]');
            if (noteField)
                noteField.value = "";
            setNotice("success", "Internal note recorded.");
            const result = await commandApi.conversation(conversationId);
            state.selected = result.detail;
        })
            .catch((error) => setNotice("error", error instanceof Error ? error.message : "The note could not be saved."))
            .finally(() => {
            state.busy = false;
            render();
        });
    }
});
let searchTimer = 0;
root.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.name === "note") {
        const form = target.closest("#note-form");
        const conversationId = form?.dataset.conversationId;
        if (conversationId)
            state.noteDrafts[conversationId] = target.value;
        return;
    }
    if (!(target instanceof HTMLInputElement) || target.id !== "conversation-search")
        return;
    state.conversationSearch = target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        void loadView("conversations");
    }, 300);
});
root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const viewControl = target.closest("[data-view]");
    if (viewControl?.dataset.view) {
        state.selected = null;
        void loadView(viewControl.dataset.view);
        return;
    }
    const filterControl = target.closest("[data-task-filter]");
    if (filterControl?.dataset.taskFilter) {
        state.taskFilter = filterControl.dataset.taskFilter;
        void loadView("tasks");
        return;
    }
    const conversationControl = target.closest("button[data-conversation-id]");
    const actionControl = target.closest("[data-action]");
    if (conversationControl?.dataset.conversationId && !actionControl) {
        void openConversation(conversationControl.dataset.conversationId);
        return;
    }
    const action = actionControl?.dataset.action;
    if (!action)
        return;
    if (action === "dismiss-notice") {
        state.notice = null;
        render();
    }
    else if (action === "close-drawer") {
        state.selected = null;
        render();
    }
    else if (action === "refresh") {
        void refreshCurrent();
    }
    else if (action === "logout") {
        state.busy = true;
        void commandApi.logout().finally(() => {
            state.staff = null;
            state.dashboard = null;
            state.tasks = [];
            state.conversations = [];
            state.selected = null;
            state.noteDrafts = {};
            state.busy = false;
            render();
        });
    }
    else if (action === "accept-task") {
        const taskId = actionControl.dataset.taskId ?? "";
        const version = Number(actionControl.dataset.version);
        state.busy = true;
        void commandApi
            .acceptTask(taskId, version)
            .then(async () => {
            setNotice("success", "Task accepted and locked to you.");
            await refreshCurrent();
        })
            .catch((error) => setNotice("error", error instanceof Error ? error.message : "The task could not be accepted."))
            .finally(() => {
            state.busy = false;
            render();
        });
    }
    else if (action === "resolve-task") {
        const taskId = actionControl.dataset.taskId ?? "";
        const version = Number(actionControl.dataset.version);
        if (!window.confirm("Mark this human-action task as resolved? The audit trail will be retained."))
            return;
        state.busy = true;
        void commandApi
            .transitionTask(taskId, version, "resolved", "Resolved from the Command Centre")
            .then(async () => {
            setNotice("success", "Task resolved.");
            await refreshCurrent();
        })
            .catch((error) => setNotice("error", error instanceof Error ? error.message : "The task could not be resolved."))
            .finally(() => {
            state.busy = false;
            render();
        });
    }
    else if (action === "takeover") {
        const conversationId = actionControl.dataset.conversationId ?? "";
        const reason = window.prompt("Reason for full human takeover", "Human handling accepted in the Command Centre");
        if (!reason)
            return;
        state.busy = true;
        void commandApi
            .takeover(conversationId, reason)
            .then(async () => {
            setNotice("success", "AI paused for this conversation.");
            const result = await commandApi.conversation(conversationId);
            state.selected = result.detail;
        })
            .catch((error) => setNotice("error", error instanceof Error ? error.message : "Takeover could not be activated."))
            .finally(() => {
            state.busy = false;
            render();
        });
    }
    else if (action === "return-ai") {
        const conversationId = actionControl.dataset.conversationId ?? "";
        const reason = window.prompt("Resolution note before returning to AI", "Human handling completed and conversation returned to AI");
        if (!reason)
            return;
        state.busy = true;
        void commandApi
            .returnToAi(conversationId, reason)
            .then(async () => {
            setNotice("success", "Conversation returned to AI handling.");
            const result = await commandApi.conversation(conversationId);
            state.selected = result.detail;
        })
            .catch((error) => setNotice("error", error instanceof Error ? error.message : "The conversation could not return to AI."))
            .finally(() => {
            state.busy = false;
            render();
        });
    }
});
async function start() {
    render();
    try {
        const session = await commandApi.session();
        if (session.authenticated && session.staff) {
            state.staff = session.staff;
            await loadView("overview", true);
        }
        else {
            state.loadingView = false;
            render();
        }
    }
    catch {
        state.loadingView = false;
        render();
    }
}
void start();
