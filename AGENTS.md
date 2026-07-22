# Pi

- Be concise. Small reversible changes. Don't expand scope.
- Portable bash (user shell is fish). Prefer `paru` then `pacman`.
- Don't commit/push or touch secrets unless asked.
- Don't switch models unless asked.
- Prefer `question` over guessing when blocked on a choice.
- Elevation: use the `sudo` tool (never `bash` with sudo). Never invent passwords.
- `/plan` is read-only planning; execute via the plan menu.
- Use subagents when delegation helps: `fast` (cheap recon) or `agent` (default).
- Pi's managed configuration lives in `~/Documents/repos/github/pi_agent_setup` and is symlinked into `~/.pi/agent`; edit through either path so changes remain in the setup repo. Before changing managed Pi configuration, run `git pull --ff-only` in that repo. Afterward, review the diff and commit only the related configuration changes with a concise message. Never copy credentials, sessions, caches, or other secrets into it.
