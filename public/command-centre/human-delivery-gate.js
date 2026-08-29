(() => {
  const launcherId = "hera-human-delivery-launcher";
  const panelId = "hera-human-delivery-panel";
  const dialogId = "hera-human-delivery-dialog";
  const refreshMs = 15000;

  const state = {
    items: [],
    deliveryEnabled: false,
    branch: "",
    loading: false,
    busyCandidateId: null,
    notice: null,
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

  function humanize(value) {
    return String(value ?? "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-SG", {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function visibleQueue() {
    return state.items.filter((item) => item && item.candidateId);
  }

  function updateLauncher() {
    const launcher = document.getElementById(launcherId);
    if (!(launcher instanceof HTMLButtonElement)) return;
    const count = visibleQueue().length;
    launcher.innerHTML = `
      <span aria-hidden="true">✓</span>
      <span>Review AI replies</span>
      <strong>${count}</strong>
    `;
    launcher.setAttribute(
      "aria-label",
      `Review ${count} AI repl${count === 1 ? "y" : "ies"}`,
    );
  }

  function ensureLauncher() {
    const topbar = document.querySelector(".topbar__actions");
    if (!topbar || document.getElementById(launcherId)) return;
    const button = document.createElement("button");
    button.id = launcherId;
    button.type = "button";
    button.className = "button button--primary human-delivery-launcher";
    button.dataset.humanDeliveryAction = "open-panel";
    topbar.prepend(button);
    updateLauncher();
  }

  function panel() {
    return document.getElementById(panelId);
  }

  function closePanel() {
    panel()?.remove();
    closeDialog();
  }

  function closeDialog() {
    document.getElementById(dialogId)?.remove();
  }

  function blockCopy(item) {
    if (!state.deliveryEnabled) {
      return "Approve & Send is available only on the authoritative staging Preview. Automatic AI delivery remains disabled.";
    }
    if (item.approvalBlockReason) {
      return humanize(item.approvalBlockReason);
    }
    return "Ready for a named human decision.";
  }

  function itemCard(item) {
    const busy = state.busyCandidateId === item.candidateId;
    const approveDisabled =
      busy || !state.deliveryEnabled || !item.canApprove;
    const rejectDisabled = busy || !item.canReject;
    const escalateDisabled = busy || !item.canEscalate;
    return `
      <article class="human-delivery-card" data-candidate-id="${escapeHtml(
        item.candidateId,
      )}">
        <header class="human-delivery-card__header">
          <div>
            <p class="eyebrow">Latest client turn</p>
            <h3>${escapeHtml(item.clientDisplayName)}</h3>
            <span>WhatsApp ending ${escapeHtml(item.phoneEnding)} · ${formatDate(
              item.candidateCreatedAt,
            )}</span>
          </div>
          <span class="risk risk--${escapeHtml(item.risk)}">
            <span class="risk__dot"></span>${escapeHtml(humanize(item.risk))}
          </span>
        </header>
        <section class="human-delivery-copy human-delivery-copy--client">
          <span>Client message</span>
          <p>${escapeHtml(item.clientMessage)}</p>
        </section>
        <section class="human-delivery-copy human-delivery-copy--candidate">
          <span>AI proposed reply · exact text</span>
          <p>${escapeHtml(item.candidateText)}</p>
        </section>
        <div class="human-delivery-integrity">
          <span>${escapeHtml(blockCopy(item))}</span>
          <small>Candidate ${escapeHtml(
            item.candidateId.slice(0, 8),
          )} · response hash ${escapeHtml(item.responseHash.slice(0, 12))}…</small>
        </div>
        <footer class="human-delivery-card__actions">
          <button
            type="button"
            class="button button--primary"
            data-human-delivery-action="approve"
            data-candidate-id="${escapeHtml(item.candidateId)}"
            ${approveDisabled ? "disabled" : ""}
          >${busy ? "Processing…" : "Approve & Send"}</button>
          <button
            type="button"
            class="button button--secondary"
            data-human-delivery-action="reject"
            data-candidate-id="${escapeHtml(item.candidateId)}"
            ${rejectDisabled ? "disabled" : ""}
          >Reject & Take Over</button>
          <button
            type="button"
            class="button button--quiet"
            data-human-delivery-action="escalate"
            data-candidate-id="${escapeHtml(item.candidateId)}"
            ${escalateDisabled ? "disabled" : ""}
          >Escalate</button>
        </footer>
      </article>
    `;
  }

  function renderPanel() {
    const current = panel();
    if (!current) return;
    const items = visibleQueue();
    current.innerHTML = `
      <div class="human-delivery-backdrop" data-human-delivery-action="close-panel"></div>
      <aside class="human-delivery-panel" role="dialog" aria-modal="true" aria-label="Human-approved AI reply queue">
        <header class="human-delivery-panel__header">
          <div>
            <p class="eyebrow">Staging human-approved delivery</p>
            <h2>Review AI replies</h2>
            <p>Nothing is sent automatically. A named human must read and approve the exact message.</p>
          </div>
          <button type="button" class="icon-button icon-button--large" data-human-delivery-action="close-panel" aria-label="Close">×</button>
        </header>
        <section class="human-delivery-mode ${
          state.deliveryEnabled ? "human-delivery-mode--ready" : ""
        }">
          <strong>${
            state.deliveryEnabled
              ? "Human-approved 360dialog delivery is enabled"
              : "Observation only on this deployment"
          }</strong>
          <span>Global AI delivery remains shadow-locked. Timely and Production are untouched.</span>
        </section>
        ${
          state.notice
            ? `<div class="human-delivery-notice human-delivery-notice--${escapeHtml(
                state.notice.type,
              )}">${escapeHtml(state.notice.message)}</div>`
            : ""
        }
        <div class="human-delivery-panel__toolbar">
          <span><strong>${items.length}</strong> exact repl${
            items.length === 1 ? "y" : "ies"
          } awaiting a human decision</span>
          <button type="button" class="button button--secondary" data-human-delivery-action="refresh" ${
            state.loading ? "disabled" : ""
          }>${state.loading ? "Refreshing…" : "Refresh"}</button>
        </div>
        <div class="human-delivery-list">
          ${
            state.loading && items.length === 0
              ? '<div class="loading-card"><span class="spinner"></span><span>Loading review queue</span></div>'
              : items.length
                ? items.map(itemCard).join("")
                : '<div class="empty-state"><div class="empty-state__mark">H</div><h3>No AI replies awaiting review</h3><p>New quality-approved shadow candidates will appear here.</p></div>'
          }
        </div>
      </aside>
    `;
  }

  function openPanel() {
    if (!panel()) {
      const shell = document.createElement("div");
      shell.id = panelId;
      document.body.append(shell);
    }
    renderPanel();
    void loadQueue(true);
  }

  function itemById(candidateId) {
    return state.items.find((item) => item.candidateId === candidateId);
  }

  function dialogShell(content) {
    closeDialog();
    const shell = document.createElement("div");
    shell.id = dialogId;
    shell.innerHTML = `
      <div class="human-delivery-dialog-backdrop" data-human-delivery-action="close-dialog"></div>
      <section class="human-delivery-dialog" role="dialog" aria-modal="true">
        ${content}
      </section>
    `;
    document.body.append(shell);
    const first = shell.querySelector("input, select, textarea, button");
    if (first instanceof HTMLElement) first.focus();
  }

  function openApproveDialog(item) {
    dialogShell(`
      <header>
        <div>
          <p class="eyebrow">Final human gate</p>
          <h2>Approve exact message?</h2>
          <p>This will send the exact displayed AI reply through 360dialog to WhatsApp ending ${escapeHtml(
            item.phoneEnding,
          )}.</p>
        </div>
        <button type="button" class="icon-button icon-button--large" data-human-delivery-action="close-dialog" aria-label="Close">×</button>
      </header>
      <form class="human-delivery-dialog__body" data-human-delivery-form="approve" data-candidate-id="${escapeHtml(
        item.candidateId,
      )}">
        <section class="human-delivery-copy human-delivery-copy--client"><span>Client message</span><p>${escapeHtml(
          item.clientMessage,
        )}</p></section>
        <section class="human-delivery-copy human-delivery-copy--candidate"><span>Message that will be sent</span><p>${escapeHtml(
          item.candidateText,
        )}</p></section>
        <label class="human-delivery-check">
          <input type="checkbox" name="confirmed" required>
          <span>I have read the latest client message, checked the exact reply and confirmed the recipient ending ${escapeHtml(
            item.phoneEnding,
          )}.</span>
        </label>
        <div class="human-delivery-dialog__actions">
          <button type="button" class="button button--secondary" data-human-delivery-action="close-dialog">Cancel</button>
          <button type="submit" class="button button--primary">Approve & Send</button>
        </div>
      </form>
    `);
  }

  function openRejectDialog(item) {
    dialogShell(`
      <header>
        <div><p class="eyebrow">Human takeover</p><h2>Reject AI reply</h2><p>The candidate will not be sent and this conversation will move to human control.</p></div>
        <button type="button" class="icon-button icon-button--large" data-human-delivery-action="close-dialog" aria-label="Close">×</button>
      </header>
      <form class="human-delivery-dialog__body" data-human-delivery-form="reject" data-candidate-id="${escapeHtml(
        item.candidateId,
      )}">
        <section class="human-delivery-copy human-delivery-copy--candidate"><span>Rejected AI reply</span><p>${escapeHtml(
          item.candidateText,
        )}</p></section>
        <label class="field"><span>Reason for rejection and takeover</span><textarea name="reason" rows="4" minlength="5" maxlength="1000" required placeholder="State what is wrong and what the human receptionist will do next."></textarea></label>
        <div class="human-delivery-dialog__actions">
          <button type="button" class="button button--secondary" data-human-delivery-action="close-dialog">Cancel</button>
          <button type="submit" class="button button--primary">Reject & Take Over</button>
        </div>
      </form>
    `);
  }

  function openEscalateDialog(item) {
    dialogShell(`
      <header>
        <div><p class="eyebrow">Specialist authority</p><h2>Escalate this reply</h2><p>The candidate will not be sent. A named human-action task will be created and the conversation will move to human control.</p></div>
        <button type="button" class="icon-button icon-button--large" data-human-delivery-action="close-dialog" aria-label="Close">×</button>
      </header>
      <form class="human-delivery-dialog__body" data-human-delivery-form="escalate" data-candidate-id="${escapeHtml(
        item.candidateId,
      )}">
        <label class="field"><span>Escalate to</span>
          <select name="escalationRole" required>
            <option value="">Choose authority</option>
            <option value="salon_manager">Salon Manager</option>
            <option value="technical_lead">Technical Lead</option>
            <option value="finance_admin">Finance & Administration</option>
            <option value="privacy_officer">Privacy & Legal</option>
          </select>
        </label>
        <label class="field"><span>Reason and required action</span><textarea name="reason" rows="4" minlength="5" maxlength="1000" required placeholder="Explain why this needs specialist authority and what must be reviewed."></textarea></label>
        <div class="human-delivery-dialog__actions">
          <button type="button" class="button button--secondary" data-human-delivery-action="close-dialog">Cancel</button>
          <button type="submit" class="button button--primary">Escalate</button>
        </div>
      </form>
    `);
  }

  async function loadQueue(render = false) {
    if (state.loading) return;
    state.loading = true;
    if (render) renderPanel();
    try {
      const result = await request(
        "/api/command-centre/human-delivery?limit=50",
      );
      state.items = Array.isArray(result.items) ? result.items : [];
      state.deliveryEnabled = result.deliveryEnabled === true;
      state.branch = typeof result.branch === "string" ? result.branch : "";
    } catch (error) {
      if (error?.status !== 401) {
        state.notice = {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "The human review queue could not be loaded.",
        };
      }
    } finally {
      state.loading = false;
      updateLauncher();
      renderPanel();
    }
  }

  async function submitAction(item, body) {
    state.busyCandidateId = item.candidateId;
    state.notice = null;
    closeDialog();
    renderPanel();
    try {
      const result = await request(
        "/api/command-centre/human-delivery",
        {
          method: "POST",
          body: JSON.stringify({
            ...body,
            candidateId: item.candidateId,
            expectedSourceMessageId: item.sourceMessageId,
            expectedResponseHash: item.responseHash,
            expectedPhoneEnding: item.phoneEnding,
          }),
        },
      );
      const sent =
        result.deliveryStatus === "sent" ||
        result.state === "sent" ||
        result.state === "already_sent" ||
        result.state === "sent_pending_audit_reconciliation";
      state.notice = {
        type: sent ? "success" : "info",
        message: sent
          ? `Message sent to WhatsApp ending ${item.phoneEnding}.`
          : humanize(result.state || "Action completed"),
      };
      await loadQueue(false);
      document
        .querySelector('[data-action="refresh"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch (error) {
      state.notice = {
        type: "error",
        message:
          error instanceof Error
            ? `${error.message}${
                error.code ? ` (${humanize(error.code)})` : ""
              }`
            : "The action could not be completed.",
      };
    } finally {
      state.busyCandidateId = null;
      renderPanel();
    }
  }

  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-human-delivery-action]")
        : null;
    const action = target?.getAttribute("data-human-delivery-action");
    if (!action) return;

    if (action === "open-panel") {
      openPanel();
      return;
    }
    if (action === "close-panel") {
      closePanel();
      return;
    }
    if (action === "close-dialog") {
      closeDialog();
      return;
    }
    if (action === "refresh") {
      void loadQueue(true);
      return;
    }

    const candidateId = target?.getAttribute("data-candidate-id");
    const item = candidateId ? itemById(candidateId) : null;
    if (!item) return;
    if (action === "approve") openApproveDialog(item);
    if (action === "reject") openRejectDialog(item);
    if (action === "escalate") openEscalateDialog(item);
  });

  document.addEventListener("submit", (event) => {
    const form =
      event.target instanceof HTMLFormElement ? event.target : null;
    const action = form?.dataset.humanDeliveryForm;
    const candidateId = form?.dataset.candidateId;
    if (!form || !action || !candidateId) return;
    event.preventDefault();
    const item = itemById(candidateId);
    if (!item) return;
    const data = new FormData(form);

    if (action === "approve") {
      if (data.get("confirmed") !== "on") return;
      void submitAction(item, { action: "approve" });
      return;
    }
    if (action === "reject") {
      const reason = String(data.get("reason") ?? "").trim();
      if (reason.length < 5) return;
      void submitAction(item, { action: "reject", reason });
      return;
    }
    if (action === "escalate") {
      const escalationRole = String(
        data.get("escalationRole") ?? "",
      );
      const reason = String(data.get("reason") ?? "").trim();
      if (!escalationRole || reason.length < 5) return;
      void submitAction(item, {
        action: "escalate",
        escalationRole,
        reason,
      });
    }
  });

  const observer = new MutationObserver(() => {
    ensureLauncher();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible") void loadQueue(false);
  }, refreshMs);

  ensureLauncher();
  window.setTimeout(() => void loadQueue(false), 1200);
})();
