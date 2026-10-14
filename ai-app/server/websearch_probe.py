"""Which OpenRouter models are free right now (CI only, temporary)."""
import json

import websearch as ws

_, _, raw = ws.fetch("https://openrouter.ai/api/v1/models", limit=8_000_000)
models = json.loads(raw.decode("utf-8", "replace"))["data"]
free = [m for m in models if m["id"].endswith(":free")]
print("free models:", len(free))
for m in sorted(free, key=lambda m: m["id"]):
    arch = m.get("architecture") or {}
    print(f'{m["id"]} | ctx {m.get("context_length")} | in {",".join(arch.get("input_modalities") or [])} | created {m.get("created")}')
for want in ("qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free", "thinkingmachines/inkling:free"):
    print("HAS", want, any(m["id"] == want for m in models))
