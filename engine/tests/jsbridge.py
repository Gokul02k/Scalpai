"""Call the v1 JavaScript engine from Python, for parity testing."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any

HARNESS = Path(__file__).resolve().parent / "js_parity_harness.mjs"
REPO = Path(__file__).resolve().parents[2]


def node_available() -> bool:
    return shutil.which("node") is not None


def call_js(module: str, fn: str, *args: Any, timeout: int = 120) -> Any:
    payload = json.dumps({"module": module, "fn": fn, "args": list(args)})
    proc = subprocess.run(
        ["node", str(HARNESS)],
        input=payload,
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=timeout,
    )
    if not proc.stdout:
        raise RuntimeError(f"node produced no output; stderr={proc.stderr[:500]}")
    body = json.loads(proc.stdout)
    if not body.get("ok"):
        raise RuntimeError(f"JS error in {module}.{fn}: {body.get('error')}")
    return body["result"]


def diff(js: Any, py: Any, path: str = "", tol: float = 0.0) -> list[str]:
    """Recursive structural diff. Returns human-readable mismatch paths.

    `tol` defaults to zero: the port reproduces JS rounding exactly, so any
    numeric drift is a real defect rather than noise to be tuned away.
    """
    out: list[str] = []

    if isinstance(js, dict) and isinstance(py, dict):
        for key in sorted(set(js) | set(py)):
            if key not in js:
                out.append(f"{path}.{key}: missing in JS (py={py[key]!r})")
            elif key not in py:
                out.append(f"{path}.{key}: missing in Python (js={js[key]!r})")
            else:
                out += diff(js[key], py[key], f"{path}.{key}", tol)
        return out

    if isinstance(js, list) and isinstance(py, list):
        if len(js) != len(py):
            out.append(f"{path}: length {len(js)} (JS) vs {len(py)} (Python)")
        for i, (a, b) in enumerate(zip(js, py)):
            out += diff(a, b, f"{path}[{i}]", tol)
        return out

    if isinstance(js, bool) or isinstance(py, bool):
        if bool(js) != bool(py):
            out.append(f"{path}: {js!r} (JS) != {py!r} (Python)")
        return out

    if isinstance(js, (int, float)) and isinstance(py, (int, float)):
        if math.isnan(float(js)) and math.isnan(float(py)):
            return out
        if tol:
            if not math.isclose(float(js), float(py), rel_tol=tol, abs_tol=tol):
                out.append(f"{path}: {js!r} (JS) != {py!r} (Python)")
        elif float(js) != float(py):
            out.append(f"{path}: {js!r} (JS) != {py!r} (Python)  delta={float(py) - float(js):.12g}")
        return out

    if js != py:
        out.append(f"{path}: {js!r} (JS) != {py!r} (Python)")
    return out
