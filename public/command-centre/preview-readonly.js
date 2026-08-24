const previewBannerId = "hera-preview-access-banner";

function replacePasswordForm() {
  const form = document.querySelector("#login-form");
  if (!(form instanceof HTMLFormElement) || form.dataset.previewPatched === "true") return;
  form.dataset.previewPatched = "true";
  form.innerHTML = `
    <div class="login-card__header">
      <p class="eyebrow">Vercel-protected Preview</p>
      <h2>Opening Command Centre</h2>
      <p>No separate Hera password is required. Your access is protected by the Vercel project permissions already used to open this Preview.</p>
    </div>
    <div class="loading-card" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span>Verifying protected Preview access</span>
    </div>
    <p class="login-card__fineprint">Customer delivery remains in shadow mode. This Preview is read-only while the full handoff controls are completed.</p>
  `;
}

function enforceReadOnlyPresentation() {
  const selectors = [
    '[data-action="accept-task"]',
    '[data-action="resolve-task"]',
    '[data-action="takeover"]',
    '[data-action="return-ai"]',
    '[data-action="logout"]',
    '#note-form',
  ];
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((element) => {
      if (element instanceof HTMLElement) element.hidden = true;
    });
  }

  const topbar = document.querySelector(".topbar__actions");
  if (topbar && !document.getElementById(previewBannerId)) {
    const badge = document.createElement("div");
    badge.id = previewBannerId;
    badge.className = "environment-badge";
    badge.innerHTML = "<span></span>Protected Preview · no password · read-only";
    topbar.prepend(badge);
  }
}

function applyPreviewPresentation() {
  replacePasswordForm();
  enforceReadOnlyPresentation();
}

new MutationObserver(applyPreviewPresentation).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

applyPreviewPresentation();
