# Pi

- Be concise; make small, focused changes.
- Ask instead of guessing when a decision is required.
- Don't touch secrets, push commits, or switch models unless asked.
- Use the `sudo` tool for elevation; never invent passwords.
- `/plan` is read-only. Delegate only when it helps (`fast` for recon, `agent` otherwise).

## Shared setup

This repository is the portable source for Pi's managed configuration, linked into `~/.pi/agent` by `install.sh`.

- On a new machine, run `./install.sh`, inspect the host, and create or update `~/AGENTS.md` with concise machine-local context while preserving existing instructions. Never copy that file into this repository. Then restart Pi or run `/reload`.
- Before editing managed configuration, run `git pull --ff-only` here.
- Review and commit related configuration changes afterward; don't push unless asked.
- Keep machine-specific context, credentials, sessions, caches, and generated state outside this repository.
