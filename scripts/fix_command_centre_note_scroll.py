from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "command-centre" / "src" / "app.ts"
TEST = ROOT / "tests" / "commandCentreNoteInteraction.test.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


app = APP.read_text(encoding="utf-8")

app = replace_once(
    app,
    '''  conversationSearch: string;\n  busy: boolean;''',
    '''  conversationSearch: string;\n  noteDrafts: Record<string, string>;\n  busy: boolean;''',
    "AppState note drafts",
)

app = replace_once(
    app,
    '''  conversationSearch: "",\n  busy: false,''',
    '''  conversationSearch: "",\n  noteDrafts: {},\n  busy: false,''',
    "initial note drafts",
)

app = replace_once(
    app,
    '''<textarea name="note" rows="3" maxlength="4000" placeholder="Record a clear internal note. This is never sent to the client."></textarea>''',
    '''<textarea name="note" rows="3" maxlength="4000" placeholder="Record a clear internal note. This is never sent to the client.">${escapeHtml(state.noteDrafts[conversation.id] ?? "")}</textarea>''',
    "rendered note draft",
)

app = replace_once(
    app,
    '''function render(): void {\n  root.innerHTML = shell();\n}\n''',
    '''interface DrawerRenderSnapshot {\n  conversationId: string;\n  bodyScrollTop: number;\n  transcriptScrollTop: number;\n  noteFocused: boolean;\n  noteSelectionStart: number | null;\n  noteSelectionEnd: number | null;\n}\n\nlet renderGeneration = 0;\n\nfunction captureDrawerRenderSnapshot(): DrawerRenderSnapshot | null {\n  const conversationId = state.selected?.conversation.id;\n  if (!conversationId) return null;\n\n  const drawerBody = root.querySelector<HTMLElement>(".drawer__body");\n  const transcript = root.querySelector<HTMLElement>(".transcript");\n  const note = root.querySelector<HTMLTextAreaElement>(\n    '#note-form textarea[name="note"]',\n  );\n  if (note) state.noteDrafts[conversationId] = note.value;\n\n  return {\n    conversationId,\n    bodyScrollTop: drawerBody?.scrollTop ?? 0,\n    transcriptScrollTop: transcript?.scrollTop ?? 0,\n    noteFocused: document.activeElement === note,\n    noteSelectionStart: note?.selectionStart ?? null,\n    noteSelectionEnd: note?.selectionEnd ?? null,\n  };\n}\n\nfunction restoreDrawerRenderSnapshot(snapshot: DrawerRenderSnapshot): void {\n  if (state.selected?.conversation.id !== snapshot.conversationId) return;\n\n  const drawerBody = root.querySelector<HTMLElement>(".drawer__body");\n  const transcript = root.querySelector<HTMLElement>(".transcript");\n  const note = root.querySelector<HTMLTextAreaElement>(\n    '#note-form textarea[name="note"]',\n  );\n  if (drawerBody) drawerBody.scrollTop = snapshot.bodyScrollTop;\n  if (transcript) transcript.scrollTop = snapshot.transcriptScrollTop;\n\n  if (note && snapshot.noteFocused) {\n    note.focus({ preventScroll: true });\n    if (\n      snapshot.noteSelectionStart !== null &&\n      snapshot.noteSelectionEnd !== null\n    ) {\n      note.setSelectionRange(\n        snapshot.noteSelectionStart,\n        snapshot.noteSelectionEnd,\n      );\n    }\n  }\n}\n\nfunction render(): void {\n  const snapshot = captureDrawerRenderSnapshot();\n  const generation = ++renderGeneration;\n  root.innerHTML = shell();\n  if (!snapshot) return;\n\n  window.requestAnimationFrame(() => {\n    if (generation !== renderGeneration) return;\n    restoreDrawerRenderSnapshot(snapshot);\n  });\n}\n''',
    "render scroll preservation",
)

app = replace_once(
    app,
    '''        setNotice("success", "Internal note recorded.");\n        const result = await commandApi.conversation(conversationId);''',
    '''        state.noteDrafts[conversationId] = "";\n        const noteField = root.querySelector<HTMLTextAreaElement>(\n          '#note-form textarea[name="note"]',\n        );\n        if (noteField) noteField.value = "";\n        setNotice("success", "Internal note recorded.");\n        const result = await commandApi.conversation(conversationId);''',
    "clear saved note draft",
)

app = replace_once(
    app,
    '''let searchTimer = 0;\nroot.addEventListener("input", (event) => {\n  const target = event.target;\n  if (!(target instanceof HTMLInputElement) || target.id !== "conversation-search") return;\n  state.conversationSearch = target.value;''',
    '''let searchTimer = 0;\nroot.addEventListener("input", (event) => {\n  const target = event.target;\n  if (target instanceof HTMLTextAreaElement && target.name === "note") {\n    const form = target.closest<HTMLFormElement>("#note-form");\n    const conversationId = form?.dataset.conversationId;\n    if (conversationId) state.noteDrafts[conversationId] = target.value;\n    return;\n  }\n  if (!(target instanceof HTMLInputElement) || target.id !== "conversation-search") return;\n  state.conversationSearch = target.value;''',
    "note draft input handling",
)

app = replace_once(
    app,
    '''  const conversationControl = target.closest<HTMLElement>("[data-conversation-id]");\n  const actionControl = target.closest<HTMLElement>("[data-action]");''',
    '''  const conversationControl = target.closest<HTMLButtonElement>(\n    "button[data-conversation-id]",\n  );\n  const actionControl = target.closest<HTMLElement>("[data-action]");''',
    "button-only conversation navigation",
)

app = replace_once(
    app,
    '''      state.conversations = [];\n      state.selected = null;\n      state.busy = false;''',
    '''      state.conversations = [];\n      state.selected = null;\n      state.noteDrafts = {};\n      state.busy = false;''',
    "logout draft cleanup",
)

APP.write_text(app, encoding="utf-8")

TEST.write_text(
    '''import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\ntest("internal-note editing cannot reopen the conversation or reset the drawer", async () => {\n  const source = await readFile(\n    new URL("../command-centre/src/app.ts", import.meta.url),\n    "utf8",\n  );\n\n  assert.match(\n    source,\n    /target\\.closest<HTMLButtonElement>\\(\\s*"button\\[data-conversation-id\\]"/,\n  );\n  assert.doesNotMatch(\n    source,\n    /target\\.closest<HTMLElement>\\("\\[data-conversation-id\\]"\\)/,\n  );\n  assert.match(source, /noteDrafts: Record<string, string>/);\n  assert.match(source, /captureDrawerRenderSnapshot/);\n  assert.match(source, /drawerBody\\.scrollTop = snapshot\\.bodyScrollTop/);\n  assert.match(source, /note\\.focus\\(\\{ preventScroll: true \\}\\)/);\n  assert.match(source, /target instanceof HTMLTextAreaElement && target\\.name === "note"/);\n});\n''',
    encoding="utf-8",
)

print("Applied Command Centre note interaction and scroll-preservation fix")
