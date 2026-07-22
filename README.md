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

   > Set up this machine's Pi configuration to match the shared setup in this repository. Run the installer, inspect this host, and create or update my machine-local `~/AGENTS.md` without overwriting existing instructions. Do not put machine-specific information or secrets in the repository.

The repository's `AGENTS.md` directs Pi through the setup. The agent will:

1. Run `./install.sh`.
2. Back up conflicting managed files under `~/.pi/agent/backups/`.
3. Link the shared configuration into `~/.pi/agent`.
4. Inspect the host and create or update the untracked, machine-local `~/AGENTS.md`.
5. Ask you to restart Pi or run `/reload`.

For a non-agent installation, run `./install.sh` directly and create `~/AGENTS.md` using the guidance below.

## Machine-local context

`~/AGENTS.md` is not part of this repository. It gives Pi host-specific context without leaking those details into the shared setup. Preserve anything already in the file and keep it short. Include only useful facts such as:

```markdown
# Machine context (pi)

- **OS:** [distribution and base]
- **Desktop:** [desktop and display protocol]
- **Shell:** [interactive shell]
- **Packages:** [preferred package manager]
- **Project locations:** [important local paths, if any]

Keep this file short. Project-specific rules go in each repository's `AGENTS.md`.
```

The setting-up agent should discover these values from the host rather than copying another machine's values. Do not include passwords, API keys, tokens, account data, or other secrets.

## Managed configuration

- `AGENTS.md` — global instructions/system-prompt context
- `settings.json`, `keybindings.json`, `presets.json`
- `agents/` and `extensions/`

The Playwright browser extension lives in `extensions/browser/`. `install.sh` installs its npm dependency and Chromium runtime. Use `/preset web-dev` to enable the `browser` tool alongside the normal implementation and web-search tools.

Commit and push repository changes normally when you want them available to other machines. The setup intentionally excludes credentials (`auth.json`), sessions, trust decisions, caches, downloaded packages, and generated model data.

## Portability

Keep machine-specific paths, operating-system details, package-manager preferences, hardware notes, and other host-local instructions in context files outside this repository (for example, a parent-directory `AGENTS.md`). Files committed here must remain portable across machines.
