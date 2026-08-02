"""wigolo Python SDK: autonomous data gathering from a script.

`local_client()` reuses a healthy local wigolo daemon if one is already
listening, otherwise spawns `wigolo serve` itself and stops it on exit. The
`agent` tool plans queries and URLs from your prompt, gathers pages within its
budget, and returns everything with full step/source transparency.

`result` is `str | dict` by contract: pass a JSON Schema and you get a dict
back when the gatherer can shape the values to it — otherwise a readable
markdown report of everything it found. Handle both, like this script does.

    python3 -m venv .venv
    .venv/bin/pip install wigolo
    .venv/bin/python gather.py
"""

import json

from wigolo import local_client

SCHEMA = {
    "type": "object",
    "properties": {
        "latest_version": {"type": "string", "description": "latest SQLite release version"},
        "release_date": {"type": "string", "description": "date that release shipped"},
    },
}

with local_client() as client:
    print(f"daemon status: {client.health().get('status')}")

    res = client.agent(
        prompt="What is the latest SQLite release version and release date?",
        schema=SCHEMA,
        urls=["https://sqlite.org/"],  # optional seed; the agent also plans its own searches
        max_pages=3,
        max_time_ms=90_000,
    )

    print(f"pages fetched: {res.get('pages_fetched')}  "
          f"steps: {len(res.get('steps', []))}  "
          f"time: {res.get('total_time_ms')}ms\n")

    result = res.get("result")
    if isinstance(result, dict):
        # Values shaped to SCHEMA.
        print(json.dumps(result, indent=2))
    else:
        # Readable gathered report (first lines).
        print("\n".join(result.splitlines()[:20]))

    print("\nsources:")
    for s in res.get("sources", [])[:4]:
        print(f"  - {s.get('url')}")
