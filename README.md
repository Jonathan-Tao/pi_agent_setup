# pi_agent_setup

Portable Pi agent configuration. Managed files are symlinked into `~/.pi/agent`, so edits made there immediately appear in this repository's working tree.

## Install on a machine

Install Pi, clone this repository, then run:

```sh
./install.sh
```

The installer backs up conflicting managed files under `~/.pi/agent/backups/`, creates links to the clone, and leaves credentials and runtime state untouched. Restart Pi or run `/reload` afterward.

## Managed configuration

- `AGENTS.md` — global instructions/system-prompt context
- `settings.json`, `keybindings.json`, `presets.json`
- `agents/` and `extensions/`

Commit and push repository changes normally when you want them available to other machines. The setup intentionally excludes credentials (`auth.json`), sessions, trust decisions, caches, downloaded packages, and generated model data.

## Portability

Keep machine-specific paths, operating-system details, package-manager preferences, hardware notes, and other host-local instructions in context files outside this repository (for example, a parent-directory `AGENTS.md`). Files committed here must remain portable across machines.
