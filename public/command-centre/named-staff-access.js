(() => {
  const launcherId = "hera-named-staff-access";
  const modalId = "hera-named-staff-modal";
  const previewOwnerEmail = "vercel-preview-owner@herabeauty.sg";

  const state = {
    staff: null,
    loading: false,
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
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : "The request could not be completed.",
      );
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

  function isPreviewOwner() {
    return state.staff?.email === previewOwnerEmail;
  }

  function closeModal() {
    document.getElementById(modalId)?.remove();
  }

  function updateLauncher() {
    const launcher = document.getElementById(launcherId);
    if (!(launcher instanceof HTMLButtonElement)) return;
    if (!state.staff) {
      launcher.textContent = "Staff access";
      return;
    }
    launcher.textContent = isPreviewOwner()
      ? "Named staff sign-in"
      : `${state.staff.displayName} · ${humanize(state.staff.role)}`;
    launcher.title = isPreviewOwner()
      ? "Sign in as the actual receptionist so every approval is named."
      : "Named staff session is active.";
  }

  function ensureLauncher() {
    const topbar = document.querySelector(".topbar__actions");
    const previewBanner = document.getElementById("hera-preview-access-banner");
    if (!topbar || !previewBanner) return;
    if (document.getElementById(launcherId)) {
      updateLauncher();
      return;
    }

    const button = document.createElement("button");
    button.id = launcherId;
    button.type = "button";
    button.className = "button button--secondary named-staff-launcher";
    button.dataset.namedStaffAction = "open";
    topbar.prepend(button);
    updateLauncher();
  }

  function openModal() {
    closeModal();
    const shell = document.createElement("div");
    shell.id = modalId;

    if (!state.staff || isPreviewOwner()) {
      shell.innerHTML = `
        <div class="named-staff-backdrop" data-named-staff-action="close"></div>
        <section class="named-staff-modal" role="dialog" aria-modal="true" aria-label="Named staff sign-in">
          <header>
            <div>
              <p class="eyebrow">Named human authority</p>
              <h2>Sign in as the actual staff member</h2>
              <p>Approvals will be recorded under this receptionist or manager profile. Neo's protected owner Preview remains the fallback after sign-out.</p>
            </div>
            <button type="button" class="icon-button icon-button--large" data-named-staff-action="close" aria-label="Close">×</button>
          </header>
          <form id="named-staff-login-form" class="named-staff-modal__body" autocomplete="on">
            <label class="field">
              <span>Staff email</span>
              <input type="email" name="email" required maxlength="320" autocomplete="username">
            </label>
            <label class="field">
              <span>Password</span>
              <input type="password" name="password" required minlength="12" maxlength="256" autocomplete="current-password">
            </label>
            <p class="named-staff-assurance">The password is submitted only to Hera's same-origin Command Centre login endpoint and is never stored by this page.</p>
            <p class="named-staff-error" role="alert" hidden></p>
            <div class="named-staff-actions">
              <button type="button" class="button button--secondary" data-named-staff-action="close">Cancel</button>
              <button type="submit" class="button button--primary">Sign in securely</button>
            </div>
          </form>
        </section>
      `;
    } else {
      shell.innerHTML = `
        <div class="named-staff-backdrop" data-named-staff-action="close"></div>
        <section class="named-staff-modal" role="dialog" aria-modal="true" aria-label="Named staff session">
          <header>
            <div>
              <p class="eyebrow">Named human authority active</p>
              <h2>${escapeHtml(state.staff.displayName)}</h2>
              <p>${escapeHtml(humanize(state.staff.role))} · every approval, rejection and escalation is attributed to this account.</p>
            </div>
            <button type="button" class="icon-button icon-button--large" data-named-staff-action="close" aria-label="Close">×</button>
          </header>
          <div class="named-staff-modal__body">
            <div class="named-staff-session">
              <span>Current operator</span>
              <strong>${escapeHtml(state.staff.displayName)}</strong>
              <small>${escapeHtml(state.staff.email)}</small>
            </div>
            <p class="named-staff-error" role="alert" hidden></p>
            <div class="named-staff-actions">
              <button type="button" class="button button--secondary" data-named-staff-action="close">Keep session</button>
              <button type="button" class="button button--quiet" data-named-staff-action="logout">Sign out and return to Neo Preview</button>
            </div>
          </div>
        </section>
      `;
    }

    document.body.append(shell);
    const first = shell.querySelector("input, button");
    if (first instanceof HTMLElement) first.focus();
  }

  function showError(message) {
    const error = document.querySelector(`#${modalId} .named-staff-error`);
    if (error instanceof HTMLElement) {
      error.textContent = message;
      error.hidden = false;
    }
  }

  async function loadSession() {
    if (state.loading) return;
    state.loading = true;
    try {
      const result = await request("/api/command-centre/auth/session");
      state.staff = result.authenticated && result.staff ? result.staff : null;
    } catch {
      state.staff = null;
    } finally {
      state.loading = false;
      ensureLauncher();
      updateLauncher();
    }
  }

  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest("[data-named-staff-action]")
        : null;
    const action = target?.getAttribute("data-named-staff-action");
    if (!action) return;

    if (action === "open") {
      openModal();
    } else if (action === "close") {
      closeModal();
    } else if (action === "logout") {
      target.setAttribute("disabled", "");
      void request("/api/command-centre/auth/logout", {
        method: "POST",
        body: "{}",
      })
        .then(() => window.location.reload())
        .catch((error) => {
          target.removeAttribute("disabled");
          showError(
            error instanceof Error ? error.message : "Sign-out failed.",
          );
        });
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id !== "named-staff-login-form") return;
    event.preventDefault();

    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const submit = form.querySelector('button[type="submit"]');
    if (submit instanceof HTMLButtonElement) submit.disabled = true;

    void request("/api/command-centre/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    })
      .then(() => {
        form.reset();
        window.location.reload();
      })
      .catch((error) => {
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
        showError(
          error instanceof Error ? error.message : "Staff sign-in failed.",
        );
      });
  });

  const observer = new MutationObserver(() => {
    ensureLauncher();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.setInterval(() => {
    ensureLauncher();
  }, 2000);

  void loadSession();
})();
