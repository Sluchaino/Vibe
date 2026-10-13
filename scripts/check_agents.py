"""Read-only structural validation for Vibe's Codex setup (Python >= 3.11)."""

from pathlib import Path
import json
import sys
import tomllib


def main():
    root = Path(__file__).resolve().parents[1]
    expected = {"architect", "backend", "android", "frontend", "reviewer"}
    errors = []
    parsed = {}
    for file in sorted((root / ".codex").rglob("*.toml")):
        try:
            parsed[file] = tomllib.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            errors.append(f"{file.relative_to(root)}: {exc}")
    config = parsed.get(root / ".codex" / "config.toml", {})
    allowed = {"enabled", "max_concurrent_threads_per_session"} | expected
    agents = config.get("agents", {})
    if set(config) != {"agents"}:
        errors.append("Project config must contain only the agents table.")
    if set(agents) != allowed:
        errors.append(f"Unexpected/missing agents keys: {set(agents) ^ allowed}")
    if agents.get("enabled") is not True:
        errors.append("Multi-agent tools are not enabled in project config.")
    if agents.get("max_concurrent_threads_per_session") != 3:
        errors.append("Expected a cap of three concurrent subagent threads.")
    files = {root / ".codex" / "agents" / f"{role}.toml" for role in expected}
    if set(parsed) != files | {root / ".codex" / "config.toml"}:
        errors.append("Expected exactly the project config and five role TOML files.")
    for role in sorted(expected):
        declaration = agents.get(role, {})
        if not isinstance(declaration, dict):
            errors.append(f"{role}: declaration must be a table")
            continue
        if set(declaration) != {"description", "config_file"}:
            errors.append(f"{role}: missing or unexpected declaration fields")
        file = (root / ".codex" / str(declaration.get("config_file", ""))).resolve()
        expected_file = root / ".codex" / "agents" / f"{role}.toml"
        if file != expected_file.resolve():
            errors.append(f"{role}: invalid config_file path")
        settings = parsed.get(expected_file, {})
        required = {"name", "description", "developer_instructions"}
        permitted = required | ({"sandbox_mode", "approval_policy"} if role == "reviewer" else set())
        if set(settings) != permitted:
            errors.append(f"{role}: missing or unexpected role fields")
        if settings.get("name") != role:
            errors.append(f"{role}: name mismatch")
        for key in ("description", "developer_instructions"):
            if not isinstance(settings.get(key), str) or not settings[key].strip():
                errors.append(f"{role}: empty {key}")
        if not isinstance(declaration.get("description"), str) or not declaration["description"].strip():
            errors.append(f"{role}: empty declaration description")
        if "AGENTS.md" not in settings.get("developer_instructions", ""):
            errors.append(f"{role}: does not reference coordinator rules")
        if role == "reviewer" and (settings.get("sandbox_mode"), settings.get("approval_policy")) != ("read-only", "never"):
            errors.append("reviewer: expected read-only sandbox without escalation")
    required_docs = ["README", "PRODUCT", "ARCHITECTURE", "DATA_MODEL", "PLANNING_RULES", "SYNC_DESIGN", "ROADMAP", "DECISIONS", "AGENT_SETUP", "SETUP_VALIDATION"]
    for name in required_docs:
        if not (root / "docs" / f"{name}.md").is_file():
            errors.append(f"Missing docs/{name}.md")
    if not (root / "AGENTS.md").is_file():
        errors.append("Missing root AGENTS.md")
    print(json.dumps({"status": "FAIL" if errors else "PASS", "toml_files": len(parsed), "roles": sorted(expected), "errors": errors, "scope": "TOML syntax and project structure only; not runtime role selection or sandbox enforcement"}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
