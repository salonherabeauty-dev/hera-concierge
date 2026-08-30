from pathlib import Path

ui_path = Path("public/command-centre/reset-workspace.js")
ui = ui_path.read_text()
ui = ui.replace(
    '    await request("/api/command-centre/bootstrap").catch(() => null);\n',
    '',
)
ui = ui.replace(
    '<button class="rr-button" data-action="regenerate" ${state.busy ? "disabled" : ""}>Regenerate</button>',
    '<button class="rr-button" data-action="regenerate" ${state.busy || !reset.retryAvailable ? "disabled" : ""}>${reset.retryAvailable ? "Regenerate" : "Regeneration used"}</button>',
)
ui = ui.replace(
    '            <button class="rr-button rr-button--primary" data-action="retry" ${state.busy ? "disabled" : ""}>${state.busy === "retry" ? "Retrying…" : "Retry AI Reply"}</button>',
    '''            ${reset.retryAvailable
              ? `<button class="rr-button rr-button--primary" data-action="retry" ${state.busy ? "disabled" : ""}>${state.busy === "retry" ? "Retrying…" : "Retry AI Reply"}</button>`
              : '<span class="rr-retry-used">The single AI retry has already been used.</span>'}''',
)
ui = ui.replace(
    '  if (!reset?.turnId) return;\n  state.busy = "retry";',
    '''  if (!reset?.turnId) return;
  if (!reset.retryAvailable) {
    setNotice("The single AI retry has already been used. Please write the reply manually.", "error");
    return;
  }
  state.busy = "retry";''',
)
required_ui = [
    'reset.retryAvailable ? "Regenerate" : "Regeneration used"',
    'The single AI retry has already been used.',
]
if any(marker not in ui for marker in required_ui):
    raise SystemExit("Required Reset v3 UI marker was not produced")
if '/api/command-centre/bootstrap' in ui:
    raise SystemExit("Invalid bootstrap GET remains in Reset v3 UI")
ui_path.write_text(ui)

css_path = Path("public/command-centre/reset-workspace.css")
css = css_path.read_text()
if ".rr-retry-used" not in css:
    css += '''

.rr-retry-used {
  align-self: center;
  max-width: 230px;
  color: var(--rr-muted, #766f68);
  font-size: 0.82rem;
  line-height: 1.35;
  text-align: right;
}
'''
css_path.write_text(css)

test_path = Path("tests/receptionistResetV3Contract.test.ts")
test = test_path.read_text()
if "RESET_MAX_TRANSPORT_RETRIES" not in test.split("} from", 1)[0]:
    test = test.replace(
        '  RESET_MAX_MODEL_CALLS,\n',
        '  RESET_MAX_MODEL_CALLS,\n  RESET_MAX_TRANSPORT_RETRIES,\n',
    )
test = test.replace(
    '  assert.match(engine, /only:\\s*\\["openai"\\]/);\n  assert.match(engine, /reasoningEffort:\\s*RESET_OPENAI_REASONING_EFFORT/);',
    '''  assert.equal(RESET_MAX_TRANSPORT_RETRIES, 1);
  assert.match(engine, /from "@ai-sdk\\/openai"/);
  assert.match(engine, /createOpenAI/);
  assert.match(engine, /\\.responses\\(RESET_OPENAI_PROVIDER_MODEL_ID\\)/);
  assert.match(engine, /process\\.env\\.OPENAI_API_KEY/);
  assert.match(engine, /maxRetries:\\s*RESET_MAX_TRANSPORT_RETRIES/);
  assert.match(engine, /reasoningEffort:\\s*RESET_OPENAI_REASONING_EFFORT/);
  assert.doesNotMatch(engine, /serviceTier:\\s*"priority"/);
  assert.doesNotMatch(engine, /from "@ai-sdk\\/gateway"/);''',
)
test = test.replace(
    '  assert.match(source, /state\\.exactCommit/);\n  assert.doesNotMatch(source, /Create AI Reply/);',
    '''  assert.match(source, /state\\.exactCommit/);
  assert.match(source, /retryAvailable/);
  assert.match(source, /single AI retry has already been used/i);
  assert.doesNotMatch(source, /\\/api\\/command-centre\\/bootstrap/);
  assert.doesNotMatch(source, /Create AI Reply/);''',
)
required_test = [
    'RESET_MAX_TRANSPORT_RETRIES',
    'from "@ai-sdk\\/openai"',
    'single AI retry has already been used',
]
if any(marker not in test for marker in required_test):
    raise SystemExit("Required Reset v3 contract marker was not produced")
test_path.write_text(test)
