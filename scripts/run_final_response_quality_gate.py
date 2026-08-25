from pathlib import Path

original = Path(__file__).with_name("apply_final_response_quality_gate.py")
source = original.read_text(encoding="utf-8")
source = source.replace("dedent('''\n    function cleanReply", "dedent(r'''\n    function cleanReply")
source = source.replace("dedent('''\n    function humanize", "dedent(r'''\n    function humanize")
namespace = {"__file__": str(original), "__name__": "__main__"}
exec(compile(source, str(original), "exec"), namespace)
