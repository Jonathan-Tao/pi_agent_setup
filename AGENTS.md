# Pi

- Be concise; make small, focused changes.
- Ask instead of guessing when a decision is required.
- Don't touch secrets, push commits outside the managed configuration sync workflow, or switch models unless asked.
- `/plan` is read-only investigation: use read-only shell/Git commands and delegate reconnaissance when helpful (`fast` for recon, `agent` otherwise).
- When changing Pi prompts, tool metadata, presets, or context, keep wording specific to its scope, describe each capability once, avoid repeating existing system instructions, and verify the assembled prompt and active tools afterward.

## Shared setup

This repository is the portable source for Pi's managed configuration, linked into `~/.pi/agent` by `install.sh`.

- On a new machine, run `./install.sh`, inspect the host, and create or update `~/AGENTS.md` with concise machine-local context while preserving existing instructions. Include useful hardware specs such as CPU core/thread count, GPU model and VRAM, and host versus WSL memory allocation when applicable. Never copy that file into this repository. Then restart Pi or run `/reload`.
- Before editing managed configuration, run `git pull --ff-only` here.
- Review, commit, and push related configuration changes afterward so they stay synchronized across machines.
- Keep machine-specific context, credentials, sessions, caches, and generated state outside this repository.
