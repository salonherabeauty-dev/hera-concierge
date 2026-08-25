from pathlib import Path

path = Path("src/command-centre/previewRepository.ts")
source = path.read_text(encoding="utf-8")
before = '''      incidents,
      candidates,
      decisions: [],
    };
'''
after = '''      incidents,
      candidates,
      decisions: [],
      jobs: [],
    };
'''
if before not in source:
    raise RuntimeError("Preview conversation return anchor was not found")
path.write_text(source.replace(before, after, 1), encoding="utf-8")
