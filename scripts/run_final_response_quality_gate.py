from pathlib import Path

original = Path(__file__).with_name("apply_final_response_quality_gate.py")
source = original.read_text(encoding="utf-8")
source = source.replace("dedent('''\n    function cleanReply", "dedent(r'''\n    function cleanReply")
source = source.replace("dedent('''\n    function humanize", "dedent(r'''\n    function humanize")
source = source.replace("old_queue = dedent('''", "old_queue = dedent(r'''")
source = source.replace("new_queue = dedent('''", "new_queue = dedent(r'''")

old_replace_once = '''def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))
'''

new_replace_once = '''def _indent_block(value: str, prefix: str, leading_newline: bool = False) -> str:
    stripped = value.lstrip("\\n")
    lines = stripped.splitlines(keepends=True)
    rendered = "".join((prefix + line if line.strip() else line) for line in lines)
    return ("\\n" if leading_newline else "") + rendered


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    candidates = [
        (old, new),
        (old.lstrip("\\n"), new.lstrip("\\n")),
    ]
    for prefix in ("  ", "    ", "      ", "        "):
        candidates.append((_indent_block(old, prefix), _indent_block(new, prefix)))
        candidates.append((_indent_block(old, prefix, True), _indent_block(new, prefix, True)))

    for candidate, replacement in candidates:
        if candidate and content.count(candidate) == 1:
            write(path, content.replace(candidate, replacement, 1))
            return

    matches = [(candidate[:120], content.count(candidate)) for candidate, _ in candidates if candidate]
    raise RuntimeError(
        f"Expected one exact or indentation-adjusted match in {path}: {matches}"
    )
'''

if source.count(old_replace_once) != 1:
    raise RuntimeError("Could not replace patcher matching helper")
source = source.replace(old_replace_once, new_replace_once, 1)

namespace = {"__file__": str(original), "__name__": "__main__"}
exec(compile(source, str(original), "exec"), namespace)

# The original worker-order contract searched for the pre-gate queue condition.
contract = original.parents[1] / "tests" / "automaticHandoffWorkerContract.test.ts"
contract_text = contract.read_text(encoding="utf-8")
old_queue = 'worker.indexOf("if (policy.canAutoSend || handoff.createTask)")'
new_queue = 'worker.indexOf("if (finalQuality.passed && (policy.canAutoSend || handoff.createTask))")'
if old_queue in contract_text:
    contract.write_text(contract_text.replace(old_queue, new_queue, 1), encoding="utf-8")

# The legacy read-only Preview repository remains compiled, although the protected
# Command Centre uses the full repository. Satisfy the expanded detail contract.
preview_repository = original.parents[1] / "src" / "command-centre" / "previewRepository.ts"
preview_text = preview_repository.read_text(encoding="utf-8")
preview_old = "      incidents,\n      candidates,\n    };"
preview_new = "      incidents,\n      candidates,\n      decisions: [],\n    };"
if preview_old in preview_text:
    preview_repository.write_text(preview_text.replace(preview_old, preview_new, 1), encoding="utf-8")
