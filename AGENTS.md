# Pi

- Be concise. Small reversible changes. Don't expand scope.
- Use portable commands; keep machine-specific details and preferences in that machine's own context files, never in this repository.
- Don't commit/push or touch secrets unless asked.
- Don't switch models unless asked.
- Prefer `question` over guessing when blocked on a choice.
- Elevation: use the `sudo` tool (never `bash` with sudo). Never invent passwords.
- `/plan` is read-only planning; execute via the plan menu.
- Use subagents when delegation helps: `fast` (cheap recon) or `agent` (default).
- Pi's managed configuration is symlinked from its setup repository into `~/.pi/agent`; locate the repository from those links rather than assuming a clone path. Before changing managed Pi configuration, run `git pull --ff-only` in that repo. Afterward, review the diff and commit only the related configuration changes with a concise message. Never add machine-specific configuration, credentials, sessions, caches, or other secrets; keep machine-local context outside this repository.
