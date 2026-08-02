"""Runtime drift test: validate the embedded manifest against the live server.

Spawns the worktree ``dist/index.js serve``, reads ``/openapi.json``, and
asserts the manifest's paths / params / required / responseKeys still match
the server. Loud failure if the manifest drifts from the real REST contract.
"""

from __future__ import annotations

import json
import urllib.request

import pytest

from conftest import DIST_INDEX, WORKTREE_ROOT, spawn_serve
from wigolo._manifest import MANIFEST


def test_resolved_command_inside_checkout():
    # The default runtime command points at the worktree dist. Assert it lives
    # inside the checkout — a loud failure otherwise.
    assert str(DIST_INDEX).startswith(str(WORKTREE_ROOT)), (
        f"dist path {DIST_INDEX} escapes the checkout {WORKTREE_ROOT}"
    )


def test_dist_built():
    if not DIST_INDEX.exists():
        pytest.fail(
            f"dist not built at {DIST_INDEX} — run `npm run build` at the repo root."
        )


@pytest.fixture(scope="module")
def openapi(shared_data_dir):
    handle = spawn_serve(shared_data_dir)
    try:
        with urllib.request.urlopen(f"{handle.base_url}/openapi.json", timeout=10) as r:
            spec = json.loads(r.read().decode())
        yield spec
    finally:
        handle.stop()


def test_manifest_paths_match_server(openapi):
    server_paths = set(openapi.get("paths", {}))
    # POST /v1/{tool} paths only (drop /v1/tools + openapi variants).
    tool_paths = {
        p
        for p, ops in openapi["paths"].items()
        if "post" in {k.lower() for k in ops}
        and p not in ("/v1/tools",)
        and "openapi" not in p
    }
    manifest_paths = {spec["path"] for spec in MANIFEST.values()}
    assert tool_paths == manifest_paths, (
        f"server POST tool paths {sorted(tool_paths)} != manifest "
        f"{sorted(manifest_paths)}"
    )
    # Sanity: exactly 10 tools.
    assert len(manifest_paths) == 10


def _post_op(openapi, path):
    ops = openapi["paths"][path]
    for k, v in ops.items():
        if k.lower() == "post":
            return v
    raise AssertionError(f"no POST op for {path}")


def _request_schema(op):
    body = op.get("requestBody", {})
    content = body.get("content", {})
    js = content.get("application/json", {})
    return js.get("schema", {})


def test_manifest_params_and_required_match(openapi):
    for tool, spec in MANIFEST.items():
        op = _post_op(openapi, spec["path"])
        schema = _request_schema(op)
        props = set(schema.get("properties", {}).keys())
        assert props == set(spec["params"]), (
            f"{tool}: server props {sorted(props)} != manifest params "
            f"{sorted(spec['params'])}"
        )
        required = set(schema.get("required", []) or [])
        assert required == set(spec["required"]), (
            f"{tool}: server required {sorted(required)} != manifest "
            f"{sorted(spec['required'])}"
        )


def test_response_keys_subset_of_server(openapi):
    for tool, spec in MANIFEST.items():
        op = _post_op(openapi, spec["path"])
        responses = op.get("responses", {})
        r200 = responses.get("200") or responses.get(200) or {}
        content = r200.get("content", {})
        js = content.get("application/json", {})
        rschema = js.get("schema", {})
        res_props = set(rschema.get("properties", {}).keys())
        if not res_props:
            # If the server does not enumerate 200 props, skip the subset check
            # for this tool loudly via xfail-style assertion.
            pytest.fail(
                f"{tool}: server 200 response has no enumerated properties to "
                f"check responseKeys against"
            )
        missing = set(spec["responseKeys"]) - res_props
        assert not missing, (
            f"{tool}: manifest responseKeys not in server 200 schema: "
            f"{sorted(missing)}"
        )
