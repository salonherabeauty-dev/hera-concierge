const root = document.querySelector("#reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception root element was not found.");
}

const state = {
  staff: null,
  items: [],
  selectedId: null,
  detail: null,
  draft: "",
  originalDraft: "",
  loading: true,
  loadingConversation: false,
  busy: null,
  deliveryEnabled: false,
  notice: null,
  loginOpen: false,
  draftDirty: false,
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
    error.code =
      typeof payload.code === "string" ? payload.code : "request_failed";
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

function initials(name) {
  const cleaned = String(name ?? "").trim();
  if (!cleaned) return "H";
  return cleaned
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

function compact(value, maximum = 88) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-SG", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRowTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(value);
  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function actionableItems() {
  return state.items.filter(
    (item) =>
      item &&
      item.candidateId &&
      item.canApprove === true &&
      !item.approvalBlockReason,
  );
}

function currentItem() {
  return actionableItems().find((item) => item.candidateId === state.selectedId) ?? null;
}

function setNotice(message, type = "success") {
  state.notice = { message, type };
  render();
  window.setTimeout(() => {
    if (state.notice?.message === message) {
      state.notice = null;
      render();
    }
  }, 5000);
}

function loadingView() {
  return `
    <main class="reception-loading">
      <section class="reception-loading__card">
        <div class="reception-loading__mark">H</div>
        <h1>Opening Hera Reception</h1>
        <p>Loading the latest client messages and AI replies.</p>
        <div class="reception-spinner" aria-label="Loading"></div>
      </section>
    </main>
  `;
}

function loginView() {
  return `
    <main class="reception-login">
      <form class="reception-login__card" data-form="login">
        <div class="reception-loading__mark">H</div>
        <h1>Hera Reception</h1>
        <p>Sign in with an authorised staff account.</p>
        <label class="reception-field">
          <span>Email</span>
          <input type="email" name="email" required autocomplete="username">
        </label>
        <label class="reception-field">
          <span>Password</span>
          <input type="password" name="password" required minlength="12" autocomplete="current-password">
        </label>
        <button class="reception-button reception-button--send" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy === "login" ? "Signing in…" : "Sign in"}
        </button>
        ${state.notice?.type === "error" ? `<p class="reception-error">${escapeHtml(state.notice.message)}</p>` : ""}
      </form>
    </main>
  `;
}

function topbar() {
  return `
    <header class="reception-topbar">
      <div class="reception-brand">
        <div class="reception-brand__mark">H</div>
        <div class="reception-brand__copy">
          <strong>Hera Reception</strong>
          <span>Human-reviewed WhatsApp replies</span>
        </div>
      </div>
      <div class="reception-topbar__spacer"></div>
      <div class="reception-channel">Tanglin WhatsApp</div>
      <button class="reception-icon-button" type="button" data-action="refresh" aria-label="Refresh">↻</button>
      <button class="reception-icon-button" type="button" data-action="staff" aria-label="Staff account">○</button>
    </header>
  `;
}

function inbox() {
  const items = actionableItems();
  return `
    <aside class="reception-inbox">
      <header class="reception-inbox__header">
        <h1>Replies waiting <span class="reception-inbox__count">${items.length}</span></h1>
        <p>Open a client, check the AI draft, edit it if needed, then send.</p>
      </header>
      <div class="reception-list">
        ${
          items.length
            ? items
                .map(
                  (item) => `
                    <button
                      type="button"
                      class="reception-row ${item.candidateId === state.selectedId ? "reception-row--selected" : ""}"
                      data-action="select"
                      data-candidate-id="${escapeHtml(item.candidateId)}"
                    >
                      <span class="reception-avatar">${escapeHtml(initials(item.clientDisplayName))}</span>
                      <span class="reception-row__body">
                        <strong>${escapeHtml(item.clientDisplayName)}</strong>
                        <p>${escapeHtml(compact(item.clientMessage || "[Non-text WhatsApp message]"))}</p>
                      </span>
                      <time class="reception-row__time">${escapeHtml(formatRowTime(item.candidateCreatedAt))}</time>
                    </button>
                  `,
                )
                .join("")
            : `
              <section class="reception-empty">
                <div class="reception-empty__inner">
                  <div class="reception-empty__icon">✓</div>
                  <h2>No replies waiting</h2>
                  <p>New quality-checked AI drafts will appear here automatically.</p>
                </div>
              </section>
            `
        }
      </div>
    </aside>
  `;
}

function transcript() {
  const item = currentItem();
  if (!item) {
    return `
      <section class="reception-workspace" hidden>
        <div></div>
      </section>
    `;
  }

  const messages = Array.isArray(state.detail?.messages)
    ? state.detail.messages.slice(-30)
    : [];

  return `
    <section class="reception-workspace">
      <header class="reception-clientbar">
        <button class="reception-icon-button reception-clientbar__back" type="button" data-action="back" aria-label="Back">‹</button>
        <span class="reception-avatar">${escapeHtml(initials(item.clientDisplayName))}</span>
        <div class="reception-clientbar__copy">
          <strong>${escapeHtml(item.clientDisplayName)}</strong>
          <span>WhatsApp ending ${escapeHtml(item.phoneEnding)}</span>
        </div>
        <div class="reception-ready">AI draft ready</div>
      </header>

      <div class="reception-thread" data-thread>
        <div class="reception-thread__inner">
          ${
            state.loadingConversation
              ? `<div class="reception-empty"><div class="reception-spinner"></div></div>`
              : messages.length
                ? messages
                    .map(
                      (message) => `
                        <article class="reception-message reception-message--${message.direction === "outbound" ? "outbound" : "inbound"}">
                          <p>${escapeHtml(message.text || `[${message.kind || "message"}]`)}</p>
                          <time>${escapeHtml(formatTime(message.providerTimestamp || message.createdAt))}</time>
                        </article>
                      `,
                    )
                    .join("")
                : `
                  <article class="reception-message reception-message--inbound">
                    <p>${escapeHtml(item.clientMessage || "[Non-text WhatsApp message]")}</p>
                  </article>
                `
          }
        </div>
      </div>

      <footer class="reception-composer">
        <div class="reception-composer__inner">
          <label class="reception-composer__label" for="reception-draft">
            <span>Reply to client</span>
            <span>${state.draft.length}/4000</span>
          </label>
          <textarea
            id="reception-draft"
            class="reception-draft"
            maxlength="4000"
            aria-label="Editable reply to client"
            ${state.busy ? "disabled" : ""}
          >${escapeHtml(state.draft)}</textarea>
          <div class="reception-statusline ${state.draftDirty ? "reception-statusline--edited" : ""}">
            ${state.draftDirty ? "Edited by you — the exact text above will be sent." : "AI draft — edit directly before sending when needed."}
          </div>
          <div class="reception-composer__footer">
            <button
              type="button"
              class="reception-button reception-button--send"
              data-action="send"
              ${!state.deliveryEnabled || state.busy || !state.draft.trim() ? "disabled" : ""}
            >${state.busy === "send" ? "Sending…" : "Send to Client"}</button>
            <button
              type="button"
              class="reception-button reception-button--secondary"
              data-action="regenerate"
              ${state.busy ? "disabled" : ""}
            >${state.busy === "regenerate" ? "Creating new reply…" : "Regenerate"}</button>
            <button
              type="button"
              class="reception-text-button"
              data-action="hold"
              ${state.busy ? "disabled" : ""}
            >Take Over / Hold</button>
            <span class="reception-composer__channel">Sent only from Tanglin WhatsApp</span>
          </div>
        </div>
      </footer>
    </section>
  `;
}

function staffModal() {
  if (!state.loginOpen) return "";
  const previewOwner = state.staff?.email === "vercel-preview-owner@herabeauty.sg";
  return `
    <div class="reception-modal">
      <div class="reception-modal__backdrop" data-action="close-staff"></div>
      <section class="reception-modal__card" role="dialog" aria-modal="true" aria-label="Staff account">
        ${
          previewOwner
            ? `
              <h2>Staff sign-in</h2>
              <p>Use the receptionist’s own account so every send is recorded under the correct staff name.</p>
              <form data-form="staff-login">
                <label class="reception-field">
                  <span>Email</span>
                  <input type="email" name="email" required autocomplete="username">
                </label>
                <label class="reception-field">
                  <span>Password</span>
                  <input type="password" name="password" required minlength="12" autocomplete="current-password">
                </label>
                <div class="reception-modal__actions">
                  <button type="button" class="reception-button reception-button--secondary" data-action="close-staff">Cancel</button>
                  <button type="submit" class="reception-button reception-button--send" ${state.busy ? "disabled" : ""}>Sign in</button>
                </div>
              </form>
            `
            : `
              <h2>${escapeHtml(state.staff?.displayName || "Staff")}</h2>
              <p>${escapeHtml(state.staff?.role || "authorised staff")} is the current operator. Sends and holds are recorded under this account.</p>
              <div class="reception-modal__actions">
                <a class="reception-text-button" href="/command-centre/advanced">Advanced records</a>
                <button type="button" class="reception-button reception-button--secondary" data-action="close-staff">Close</button>
                <button type="button" class="reception-button reception-button--send" data-action="logout">Sign out</button>
              </div>
            `
        }
      </section>
    </div>
  `;
}

function shell() {
  return `
    <div class="reception-shell">
      ${topbar()}
      <div class="reception-layout">
        ${inbox()}
        ${transcript()}
      </div>
      ${state.notice ? `<div class="reception-notice reception-notice--${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}
      ${staffModal()}
    </div>
  `;
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
  const thread = root.querySelector("[data-thread]");
  if (thread instanceof HTMLElement) {
    thread.scrollTop = thread.scrollHeight;
  }
}

async function loadConversation(item) {
  state.loadingConversation = true;
  state.detail = null;
  render();
  try {
    const result = await request(
      `/api/command-centre/conversation?id=${encodeURIComponent(item.conversationId)}`,
    );
    state.detail = result.detail ?? null;
  } catch (error) {
    setNotice(
      error instanceof Error ? error.message : "The conversation could not be loaded.",
      "error",
    );
  } finally {
    state.loadingConversation = false;
    render();
  }
}

async function selectItem(candidateId) {
  const item = actionableItems().find((entry) => entry.candidateId === candidateId);
  if (!item) return;
  state.selectedId = item.candidateId;
  state.draft = item.candidateText;
  state.originalDraft = item.candidateText;
  state.draftDirty = false;
  await loadConversation(item);
}

async function loadQueue({ keepSelection = true } = {}) {
  const previousId = keepSelection ? state.selectedId : null;
  const result = await request("/api/command-centre/receptionist-queue?limit=100");
  state.items = Array.isArray(result.items) ? result.items : [];
  state.deliveryEnabled = result.deliveryEnabled === true;

  const items = actionableItems();
  const isCompact = window.matchMedia("(max-width: 820px)").matches;
  const selected =
    items.find((item) => item.candidateId === previousId) ??
    (!keepSelection && isCompact ? null : items[0] ?? null);

  if (!selected) {
    state.selectedId = null;
    state.detail = null;
    state.draft = "";
    state.originalDraft = "";
    state.draftDirty = false;
    return;
  }

  const selectionChanged = selected.candidateId !== state.selectedId;
  state.selectedId = selected.candidateId;
  if (selectionChanged || !state.draftDirty) {
    state.draft = selected.candidateText;
    state.originalDraft = selected.candidateText;
    state.draftDirty = false;
  }
  if (selectionChanged || !state.detail) {
    await loadConversation(selected);
  }
}

async function start() {
  render();
  try {
    const session = await request("/api/command-centre/auth/session");
    state.staff = session.authenticated && session.staff ? session.staff : null;
    state.loading = false;
    if (state.staff) await loadQueue({ keepSelection: false });
  } catch {
    state.staff = null;
    state.loading = false;
  }
  render();
}

async function sendCurrent() {
  const item = currentItem();
  if (!item || !state.draft.trim()) return;
  state.busy = "send";
  render();
  try {
    const result = await request("/api/command-centre/receptionist-message", {
      method: "POST",
      body: JSON.stringify({
        action: "send",
        candidateId: item.candidateId,
        expectedSourceMessageId: item.sourceMessageId,
        expectedCandidateHash: item.responseHash,
        expectedPhoneEnding: item.phoneEnding,
        messageText: state.draft,
      }),
    });
    const edited = result.editedByHuman === true || state.draftDirty;
    setNotice(
      edited
        ? "Edited reply sent from Tanglin WhatsApp."
        : "AI reply sent from Tanglin WhatsApp.",
    );
    state.busy = null;
    await loadQueue({ keepSelection: false });
  } catch (error) {
    state.busy = null;
    setNotice(
      error instanceof Error ? error.message : "The reply could not be sent.",
      "error",
    );
  }
  render();
}

async function regenerateCurrent() {
  const item = currentItem();
  if (!item) return;
  if (
    state.draftDirty &&
    !window.confirm("Create a new AI draft and discard your current edits?")
  ) {
    return;
  }
  state.busy = "regenerate";
  render();
  try {
    const result = await request("/api/command-centre/receptionist-regenerate", {
      method: "POST",
      body: JSON.stringify({
        candidateId: item.candidateId,
        expectedSourceMessageId: item.sourceMessageId,
        expectedCandidateHash: item.responseHash,
        expectedPhoneEnding: item.phoneEnding,
      }),
    });
    state.busy = null;
    if (result.item) {
      state.items = [
        result.item,
        ...state.items.filter(
          (entry) => entry.candidateId !== item.candidateId && entry.candidateId !== result.item.candidateId,
        ),
      ];
      state.selectedId = result.item.candidateId;
      state.draft = result.item.candidateText;
      state.originalDraft = result.item.candidateText;
      state.draftDirty = false;
      await loadConversation(result.item);
    } else {
      await loadQueue({ keepSelection: false });
    }
    setNotice(
      result.state === "regeneration_pending"
        ? "A new AI reply is still being prepared. This page will refresh automatically."
        : result.state === "original_restored"
          ? "A new reply could not be completed, so the original AI draft was kept."
          : "A new AI reply is ready.",
      result.state === "original_restored" ? "error" : "success",
    );
  } catch (error) {
    state.busy = null;
    setNotice(
      error instanceof Error ? error.message : "A new reply could not be generated.",
      "error",
    );
  }
  render();
}

async function holdCurrent() {
  const item = currentItem();
  if (!item) return;
  const confirmed = window.confirm(
    "Take over this conversation? The AI draft will not be sent.",
  );
  if (!confirmed) return;

  state.busy = "hold";
  render();
  try {
    await request("/api/command-centre/receptionist-message", {
      method: "POST",
      body: JSON.stringify({
        action: "hold",
        candidateId: item.candidateId,
        expectedSourceMessageId: item.sourceMessageId,
        expectedCandidateHash: item.responseHash,
        expectedPhoneEnding: item.phoneEnding,
      }),
    });
    state.busy = null;
    setNotice("Conversation held for human handling. Nothing was sent.");
    await loadQueue({ keepSelection: false });
  } catch (error) {
    state.busy = null;
    setNotice(
      error instanceof Error ? error.message : "The conversation could not be held.",
      "error",
    );
  }
  render();
}

root.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || target.id !== "reception-draft") {
    return;
  }
  state.draft = target.value;
  state.draftDirty = target.value !== state.originalDraft;
  const label = root.querySelector(".reception-composer__label span:last-child");
  if (label) label.textContent = `${state.draft.length}/4000`;
  const status = root.querySelector(".reception-statusline");
  if (status) {
    status.classList.toggle("reception-statusline--edited", state.draftDirty);
    status.textContent = state.draftDirty
      ? "Edited by you — the exact text above will be sent."
      : "AI draft — edit directly before sending when needed.";
  }
  const send = root.querySelector('[data-action="send"]');
  if (send instanceof HTMLButtonElement) {
    send.disabled =
      !state.deliveryEnabled || Boolean(state.busy) || !state.draft.trim();
  }
});

root.addEventListener("click", (event) => {
  const target =
    event.target instanceof Element ? event.target.closest("[data-action]") : null;
  const action = target?.getAttribute("data-action");
  if (!action) return;

  if (action === "select") {
    void selectItem(target.getAttribute("data-candidate-id") || "");
  } else if (action === "back") {
    state.selectedId = null;
    state.detail = null;
    render();
  } else if (action === "refresh") {
    if (state.busy) return;
    state.busy = "refresh";
    render();
    void loadQueue()
      .catch((error) =>
        setNotice(
          error instanceof Error ? error.message : "Refresh failed.",
          "error",
        ),
      )
      .finally(() => {
        state.busy = null;
        render();
      });
  } else if (action === "send") {
    void sendCurrent();
  } else if (action === "regenerate") {
    void regenerateCurrent();
  } else if (action === "hold") {
    void holdCurrent();
  } else if (action === "staff") {
    state.loginOpen = true;
    render();
  } else if (action === "close-staff") {
    state.loginOpen = false;
    render();
  } else if (action === "logout") {
    state.busy = "logout";
    void request("/api/command-centre/auth/logout", {
      method: "POST",
      body: "{}",
    }).finally(() => window.location.reload());
  }
});

root.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const formType = form.dataset.form;
  if (formType !== "login" && formType !== "staff-login") return;
  event.preventDefault();

  const data = new FormData(form);
  const email = String(data.get("email") ?? "").trim();
  const password = String(data.get("password") ?? "");
  state.busy = "login";
  render();

  void request("/api/command-centre/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
    .then(() => window.location.reload())
    .catch((error) => {
      state.busy = null;
      state.loginOpen = formType === "staff-login";
      setNotice(
        error instanceof Error ? error.message : "Sign-in failed.",
        "error",
      );
    });
});

window.setInterval(() => {
  if (
    document.visibilityState === "visible" &&
    !state.busy &&
    state.staff
  ) {
    void loadQueue()
      .then(() => render())
      .catch(() => undefined);
  }
}, 15000);

void start();
