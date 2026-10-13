"""Read-only Codex config/prompt diagnostics. No model calls or settings writes."""

from pathlib import Path
import json
import queue
import shutil
import subprocess
import sys
import threading


def main():
    root = Path(__file__).resolve().parents[1]
    codex = shutil.which("codex")
    if not codex:
        print(json.dumps({"status": "UNAVAILABLE", "reason": "codex executable not found"}))
        return 1
    report = {"scope": "Config and prompt diagnostics only; no model call, role spawn or sandbox write test"}
    process = subprocess.Popen([codex, "app-server", "--stdio", "--strict-config"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    lines = queue.Queue()
    errors = []

    def read_stdout():
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    def read_stderr():
        for line in process.stderr:
            errors.append(line.strip())

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()

    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

    def request(number, method, params):
        import time
        send({"id": number, "method": method, "params": params})
        deadline = time.monotonic() + 25
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"No response to {method}")
            line = lines.get(timeout=remaining)
            if line is None:
                raise RuntimeError(f"Codex exited before replying to {method}")
            try:
                response = json.loads(line)
            except ValueError:
                continue
            if response.get("id") == number:
                if "error" in response:
                    raise RuntimeError(f"{method}: {response['error']}")
                return response.get("result", {})

    try:
        initialized = request(1, "initialize", {"clientInfo": {"name": "vibe_setup_probe", "title": "Vibe setup probe", "version": "1.0.0"}})
        send({"method": "initialized"})
        report["server_user_agent"] = initialized.get("userAgent")
        result = request(2, "config/read", {"cwd": str(root), "includeLayers": True})
        settings = result.get("config", {}).get("agents", {})
        report["strict_config_read"] = "PASS"
        report["agents_config"] = settings
        # Keep source metadata only. Never print unrelated user config values.
        report["layers"] = [{key: value for key, value in layer.items() if key not in {"config", "contents", "raw"}} for layer in result.get("layers", [])]
        project_layers = [layer for layer in result.get("layers", []) if layer.get("name", {}).get("type") == "project" and Path(layer.get("name", {}).get("dotCodexFolder", "")).resolve() == (root / ".codex").resolve()]
        report["project_layer_active"] = bool(project_layers) and all(not layer.get("disabledReason") for layer in project_layers)
        expected_roles = {"architect", "backend", "android", "frontend", "reviewer"}
        report["registered_roles_loaded"] = sorted(expected_roles & set(settings or {}))
        report["runtime_role_declarations_loaded"] = expected_roles <= set(settings or {})
        report["project_strict_parse_verified"] = report["project_layer_active"] and report["runtime_role_declarations_loaded"]
    except (RuntimeError, TimeoutError, queue.Empty, OSError) as exc:
        report["strict_config_read"] = "FAIL"
        report["error"] = str(exc)
    finally:
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=3)

    try:
        prompt = subprocess.run([codex, "debug", "prompt-input", "Vibe setup diagnostic: do not execute work."], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=25)
        if prompt.returncode:
            report["prompt_check"] = "FAIL"
            report["prompt_error"] = prompt.stderr[-1500:]
        else:
            decoded = json.loads(prompt.stdout)
            rendered = json.dumps(decoded, ensure_ascii=False)
            coordinator = (root / "AGENTS.md").read_text(encoding="utf-8")
            report["prompt_check"] = "PASS"
            report["coordinator_heading_visible"] = coordinator.splitlines()[0] in rendered
            report["coordinator_gate_visible"] = "Сейчас разрешены только настройка агентов" in rendered
            report["role_names_visible"] = {role: role in rendered for role in ["architect", "backend", "android", "frontend", "reviewer"]}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        report["prompt_check"] = "FAIL"
        report["prompt_error"] = str(exc)
    if report.get("strict_config_read") == "PASS" and not report.get("project_layer_active"):
        report["status"] = "BLOCKED_TRUST"
    elif all(report.get(key) for key in ("project_layer_active", "runtime_role_declarations_loaded", "coordinator_heading_visible", "coordinator_gate_visible")) and report.get("prompt_check") == "PASS":
        report["status"] = "PASS"
    else:
        report["status"] = "FAIL"
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
