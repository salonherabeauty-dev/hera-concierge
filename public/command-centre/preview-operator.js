const previewBannerId = "hera-preview-access-banner";
const outcomeModalId = "hera-task-outcome-modal";

const bookingOutcomes = {
  appointment_confirmed: {
    label: "Appointment confirmed in Timely",
    status: "resolved",
    help: "Use only after a human receptionist has created and verified the appointment in Timely.",
  },
  alternative_offered: {
    label: "Alternative offered — waiting for client",
    status: "waiting_client",
    help: "The requested slot was unavailable and one or more alternatives were offered.",
  },
  more_information_required: {
    label: "More information required from client",
    status: "waiting_client",
    help: "The client must provide or clarify something before reception can proceed.",
  },
  waiting_internal: {
    label: "Waiting for internal confirmation",
    status: "waiting_internal",
    help: "Reception is waiting for a stylist, manager or outlet confirmation.",
  },
  stylist_unavailable: {
    label: "Stylist unavailable — task concluded",
    status: "resolved",
    help: "No suitable option is available and the booking request is concluded for now.",
  },
  client_declined: {
    label: "Client declined or no longer wishes to book",
    status: "resolved",
    help: "The client declined the available option or withdrew the request.",
  },
  test_completed: {
    label: "Controlled staging test completed",
    status: "resolved",
    help: "Use only for an approved staging test. This does not represent a real appointment.",
  },
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
  const method = (options.method ?? "GET").toUpperCase();
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
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function replacePasswordForm() {
  const form = document.querySelector("#login-form");
  if (!(form instanceof HTMLFormElement) || form.dataset.previewPatched === "true") return;
  form.dataset.previewPatched = "true";
  form.innerHTML = `
    <div class="login-card__header">
      <p class="eyebrow">Vercel-protected Preview</p>
      <h2>Opening Command Centre</h2>
      <p>No separate Hera password is required. Vercel project access establishes the protected Preview boundary.</p>
    </div>
    <div class="loading-card" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span>Loading Neo Chin Chuan’s named operator workspace</span>
    </div>
    <p class="login-card__fineprint">Task ownership and audit controls are active. WhatsApp customer delivery remains locked to shadow mode.</p>
  `;
}

function patchPreviewBanner() {
  const topbar = document.querySelector(".topbar__actions");
  if (!topbar || document.getElementById(previewBannerId)) return;
  const badge = document.createElement("div");
  badge.id = previewBannerId;
  badge.className = "environment-badge preview-operator-badge";
  badge.innerHTML = "<span></span>Protected Preview · Neo Chin Chuan · task controls · shadow";
  topbar.prepend(badge);
}

function hidePreviewLogout() {
  document.querySelectorAll('[data-action="logout"]').forEach((element) => {
    if (element instanceof HTMLElement) element.hidden = true;
  });
}

function taskIsOpen(task) {
  return task && !["resolved", "cancelled"].includes(task.status);
}

function statusLabel(status) {
  return String(status ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function closeModal() {
  document.getElementById(outcomeModalId)?.remove();
}

function modalShell(inner) {
  closeModal();
  const modal = document.createElement("div");
  modal.id = outcomeModalId;
  modal.className = "preview-modal-shell";
  modal.innerHTML = `
    <div class="preview-modal-backdrop" data-preview-action="close-modal"></div>
    <section class="preview-modal" role="dialog" aria-modal="true" aria-label="Human action workflow">
      ${inner}
    </section>
  `;
  document.body.append(modal);
  const first = modal.querySelector("select, textarea, input, button");
  if (first instanceof HTMLElement) first.focus();
}

function outcomeOptions(selected = "") {
  return Object.entries(bookingOutcomes)
    .map(
      ([value, outcome]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${outcome.label}</option>`,
    )
    .join("");
}

function openBookingOutcomeModal(task) {
  modalShell(`
    <header class="preview-modal__header">
      <div>
        <p class="eyebrow">Named human action</p>
        <h2>Choose booking outcome</h2>
        <p>This updates the durable task record only. It does not send a WhatsApp message or create a Timely booking.</p>
      </div>
      <button type="button" class="icon-button icon-button--large" data-preview-action="close-modal" aria-label="Close">×</button>
    </header>
    <form id="preview-booking-outcome-form" class="preview-modal__body"
      data-task-id="${task.id}" data-version="${task.version}">
      <div class="preview-owner-lock">
        <span>Locked owner</span>
        <strong>${task.ownerDisplayName ?? "Named operator"}</strong>
        <small>Task status: ${statusLabel(task.status)} · optimistic version ${task.version}</small>
      </div>
      <label class="field">
        <span>Booking outcome</span>
        <select name="outcome" required>
          <option value="">Select the verified outcome</option>
          ${outcomeOptions()}
        </select>
      </label>
      <p class="preview-outcome-help" id="preview-outcome-help">Choose the actual human-verified outcome.</p>
      <label class="field preview-confirmation-field" hidden>
        <span>Timely booking reference or appointment identifier</span>
        <input name="bookingReference" maxlength="160" placeholder="For example: Timely appointment ID or booking reference">
      </label>
      <label class="preview-check preview-confirmation-field" hidden>
        <input type="checkbox" name="confirmedByHuman">
        <span>I personally verified that the appointment was created in Timely.</span>
      </label>
      <label class="field">
        <span>Internal outcome note</span>
        <textarea name="note" rows="4" maxlength="2000" required placeholder="Record what reception checked, what was decided, and the next responsibility. This is not sent to the client."></textarea>
      </label>
      <div class="preview-modal__actions">
        <button type="button" class="button button--secondary" data-preview-action="close-modal">Cancel</button>
        <button type="submit" class="button button--primary">Apply outcome</button>
      </div>
      <p class="preview-form-error" role="alert" hidden></p>
    </form>
  `);
}

function openGenericResolutionModal(task) {
  modalShell(`
    <header class="preview-modal__header">
      <div><p class="eyebrow">Named human action</p><h2>Resolve human-action task</h2><p>The full audit history will be retained.</p></div>
      <button type="button" class="icon-button icon-button--large" data-preview-action="close-modal" aria-label="Close">×</button>
    </header>
    <form id="preview-generic-resolution-form" class="preview-modal__body"
      data-task-id="${task.id}" data-version="${task.version}">
      <div class="preview-owner-lock"><span>Locked owner</span><strong>${task.ownerDisplayName ?? "Named operator"}</strong><small>Task status: ${statusLabel(task.status)}</small></div>
      <label class="field"><span>Resolution note</span><textarea name="note" rows="4" maxlength="2000" required placeholder="State exactly what was completed and why the task can close."></textarea></label>
      <div class="preview-modal__actions"><button type="button" class="button button--secondary" data-preview-action="close-modal">Cancel</button><button type="submit" class="button button--primary">Resolve task</button></div>
      <p class="preview-form-error" role="alert" hidden></p>
    </form>
  `);
}

async function openOutcomeForTask(taskId, version) {
  const result = await request("/api/command-centre/tasks?status=open");
  const task = (result.tasks ?? []).find((item) => item.id === taskId);
  if (!task) throw new Error("The task changed or is no longer open. Refresh the Command Centre.");
  if (Number(task.version) !== Number(version)) {
    throw new Error("The task changed. Refresh before choosing an outcome.");
  }
  if (task.taskType === "booking_action") openBookingOutcomeModal(task);
  else openGenericResolutionModal(task);
}

function openReturnToAiModal(conversationId) {
  modalShell(`
    <header class="preview-modal__header">
      <div><p class="eyebrow">Deliberate handback</p><h2>Return conversation to AI</h2><p>This is allowed only after accepted human work is resolved or cancelled.</p></div>
      <button type="button" class="icon-button icon-button--large" data-preview-action="close-modal" aria-label="Close">×</button>
    </header>
    <form id="preview-return-ai-form" class="preview-modal__body" data-conversation-id="${conversationId}">
      <label class="field"><span>Resolution and handback note</span><textarea name="reason" rows="4" maxlength="1000" required placeholder="Confirm that human handling is complete and explain why AI may resume."></textarea></label>
      <label class="preview-check"><input type="checkbox" name="confirmed" required><span>I have verified that no accepted human-action task remains unresolved.</span></label>
      <div class="preview-modal__actions"><button type="button" class="button button--secondary" data-preview-action="close-modal">Keep human handling</button><button type="submit" class="button button--primary">Return to AI</button></div>
      <p class="preview-form-error" role="alert" hidden></p>
    </form>
  `);
}

function formError(form, message) {
  const error = form.querySelector(".preview-form-error");
  if (error instanceof HTMLElement) {
    error.textContent = message;
    error.hidden = false;
  }
}

async function submitBookingOutcome(form) {
  const data = new FormData(form);
  const outcomeKey = String(data.get("outcome") ?? "");
  const outcome = bookingOutcomes[outcomeKey];
  const note = String(data.get("note") ?? "").trim();
  if (!outcome) throw new Error("Choose a booking outcome.");
  if (note.length < 5) throw new Error("Add a clear internal outcome note.");

  const confirmedByHuman = data.get("confirmedByHuman") === "on";
  const bookingReference = String(data.get("bookingReference") ?? "").trim();
  const resolution = {
    outcome: outcomeKey,
    summary: note,
    confirmedByHuman,
    bookingReference: bookingReference || null,
    recordedFrom: "protected_command_centre_preview",
  };

  await request("/api/command-centre/task-action", {
    method: "POST",
    body: JSON.stringify({
      action: "transition",
      taskId: form.dataset.taskId,
      expectedVersion: Number(form.dataset.version),
      toStatus: outcome.status,
      note,
      resolution,
    }),
  });
}

async function submitGenericResolution(form) {
  const data = new FormData(form);
  const note = String(data.get("note") ?? "").trim();
  if (note.length < 5) throw new Error("Add a clear resolution note.");
  await request("/api/command-centre/task-action", {
    method: "POST",
    body: JSON.stringify({
      action: "transition",
      taskId: form.dataset.taskId,
      expectedVersion: Number(form.dataset.version),
      toStatus: "resolved",
      note,
      resolution: {
        outcome: "human_action_completed",
        summary: note,
        recordedFrom: "protected_command_centre_preview",
      },
    }),
  });
}

async function submitReturnToAi(form) {
  const data = new FormData(form);
  const reason = String(data.get("reason") ?? "").trim();
  if (reason.length < 5) throw new Error("Add a clear handback note.");
  if (data.get("confirmed") !== "on") {
    throw new Error("Confirm that all accepted human work is complete.");
  }
  await request("/api/command-centre/conversation", {
    method: "POST",
    body: JSON.stringify({
      action: "return_to_ai",
      conversationId: form.dataset.conversationId,
      reason,
    }),
  });
}

async function enhanceDrawer(drawer) {
  if (!(drawer instanceof HTMLElement) || drawer.dataset.previewLoading === "true") return;
  const control = drawer.querySelector("[data-conversation-id], #note-form");
  const conversationId =
    control?.dataset.conversationId ??
    drawer.querySelector("#note-form")?.dataset.conversationId ??
    "";
  if (!conversationId || drawer.dataset.previewEnhancedFor === conversationId) return;

  drawer.dataset.previewLoading = "true";
  try {
    const result = await request(
      `/api/command-centre/conversation?id=${encodeURIComponent(conversationId)}`,
    );
    if (!document.body.contains(drawer)) return;
    drawer.dataset.previewEnhancedFor = conversationId;
    const detail = result.detail;
    const activeTask = (detail.tasks ?? []).find(taskIsOpen);
    const buttonStack = drawer.querySelector(".button-stack");
    if (!(buttonStack instanceof HTMLElement)) return;

    buttonStack.querySelector(".preview-workflow-card")?.remove();
    const workflow = document.createElement("section");
    workflow.className = "preview-workflow-card";

    if (activeTask) {
      const owned = Boolean(activeTask.ownerUserId);
      const canChooseOutcome = [
        "accepted",
        "waiting_client",
        "waiting_internal",
      ].includes(activeTask.status);
      workflow.innerHTML = `
        <p class="eyebrow">Named task control</p>
        <div class="preview-workflow-card__owner"><span>Owner</span><strong>${activeTask.ownerDisplayName ?? "Unassigned"}</strong></div>
        <p>Status: ${statusLabel(activeTask.status)} · Version ${activeTask.version}</p>
        ${!owned ? "<small>Accept the task to lock it to Neo Chin Chuan before recording an outcome.</small>" : ""}
        ${canChooseOutcome ? `<button type="button" class="button button--secondary button--full" data-preview-action="open-outcome" data-preview-task-id="${activeTask.id}" data-preview-version="${activeTask.version}">Choose ${activeTask.taskType === "booking_action" ? "booking outcome" : "resolution"}</button>` : ""}
      `;
    } else if (detail.conversation?.operatingMode === "management") {
      workflow.innerHTML = `
        <p class="eyebrow">Human work complete</p>
        <strong>No open human-action task remains.</strong>
        <p>Use the deliberate handback control when the conversation is ready for AI assistance again.</p>
      `;
    }

    buttonStack.append(workflow);
  } catch (error) {
    console.warn("Preview drawer enhancement could not load", error);
  } finally {
    drawer.dataset.previewLoading = "false";
  }
}

function patchTaskButtons() {
  document.querySelectorAll('[data-action="resolve-task"]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.textContent = "Choose outcome";
    button.classList.add("preview-outcome-button");
  });
}

function applyPreviewPresentation() {
  replacePasswordForm();
  patchPreviewBanner();
  hidePreviewLogout();
  patchTaskButtons();
  document.querySelectorAll(".drawer").forEach((drawer) => void enhanceDrawer(drawer));
}

new MutationObserver(applyPreviewPresentation).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

window.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.name !== "outcome") return;
  const outcome = bookingOutcomes[target.value];
  const modal = target.closest(".preview-modal");
  const help = modal?.querySelector("#preview-outcome-help");
  if (help instanceof HTMLElement) {
    help.textContent = outcome?.help ?? "Choose the actual human-verified outcome.";
  }
  modal?.querySelectorAll(".preview-confirmation-field").forEach((element) => {
    if (element instanceof HTMLElement) {
      element.hidden = target.value !== "appointment_confirmed";
    }
  });
});

window.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const previewControl = target.closest("[data-preview-action]");
    if (previewControl instanceof HTMLElement) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const action = previewControl.dataset.previewAction;
      if (action === "close-modal") {
        closeModal();
      } else if (action === "open-outcome") {
        void openOutcomeForTask(
          previewControl.dataset.previewTaskId ?? "",
          Number(previewControl.dataset.previewVersion),
        ).catch((error) => window.alert(error.message));
      }
      return;
    }

    const actionControl = target.closest("[data-action]");
    if (!(actionControl instanceof HTMLElement)) return;
    const action = actionControl.dataset.action;
    if (action === "resolve-task") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void openOutcomeForTask(
        actionControl.dataset.taskId ?? "",
        Number(actionControl.dataset.version),
      ).catch((error) => window.alert(error.message));
    } else if (action === "return-ai") {
      event.preventDefault();
      event.stopImmediatePropagation();
      openReturnToAiModal(actionControl.dataset.conversationId ?? "");
    }
  },
  true,
);

window.addEventListener(
  "submit",
  (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (
      ![
        "preview-booking-outcome-form",
        "preview-generic-resolution-form",
        "preview-return-ai-form",
      ].includes(form.id)
    ) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const submit = form.querySelector('button[type="submit"]');
    if (submit instanceof HTMLButtonElement) submit.disabled = true;

    let operation;
    if (form.id === "preview-booking-outcome-form") {
      operation = submitBookingOutcome(form);
    } else if (form.id === "preview-generic-resolution-form") {
      operation = submitGenericResolution(form);
    } else {
      operation = submitReturnToAi(form);
    }

    void operation
      .then(() => {
        closeModal();
        window.location.reload();
      })
      .catch((error) => formError(form, error.message))
      .finally(() => {
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
      });
  },
  true,
);

applyPreviewPresentation();
