# pi_agent_setup

Portable Pi agent configuration. Managed files are symlinked into `~/.pi/agent`, so edits made there immediately appear in this repository's working tree.

## Set up a new machine with Pi

1. Install Pi and Git.
2. Clone and enter this repository:

   ```sh
   git clone git@github.com:Jonathan-Tao/pi_agent_setup.git
   cd pi_agent_setup
   ```

3. Start Pi from the repository:

   ```sh
   pi
   ```

4. Tell the agent:

   > Set up this machine's Pi configuration to match the shared setup in this repository.

The repository's `AGENTS.md` tells Pi to run `./install.sh`. The installer backs up conflicting managed files under `~/.pi/agent/backups/`, links the shared configuration into `~/.pi/agent`, and leaves machine-local state untouched. Restart Pi or run `/reload` afterward.

For a non-agent installation, run `./install.sh` directly.

## Managed configuration

- `AGENTS.md` — global instructions/system-prompt context
- `settings.json`, `keybindings.json`, `presets.json`
- `agents/` and `extensions/`

Commit and push repository changes normally when you want them available to other machines. The setup intentionally excludes credentials (`auth.json`), sessions, trust decisions, caches, downloaded packages, and generated model data.

## Portability

Keep machine-specific paths, operating-system details, package-manager preferences, hardware notes, and other host-local instructions in context files outside this repository (for example, a parent-directory `AGENTS.md`). Files committed here must remain portable across machines.
