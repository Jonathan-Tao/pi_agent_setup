# Plan Mode Extension

Read-only investigation mode for implementation planning.

## Features

- **Direct mutations disabled**: Disables edit/write/sudo while preserving investigation tools
- **Bash mutation guard**: Allows arbitrary investigation commands, including read-only Git commands, while blocking known mutating/destructive patterns
- **Read-only delegation**: Keeps subagents available and adds a read-only reconnaissance constraint to delegated tasks
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Shift+Tab` or `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. When a plan is ready, choose one of:
   - **Execute plan** — run with full chat context
   - **Execute plan (clear planning context)** — drop exploration chatter; keep full plan text + execution history (does not amnesia-loop)
   - **Stay in plan mode** — keep refining without executing
   - **Refine the plan** — send extra instructions
   - **Exit plan mode** — restore full tools, discard execution tracking
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## How It Works

### Plan Mode (Read-Only)
- Built-in edit/write/sudo tools disabled
- Other active tools, including subagents, remain available
- Bash allows investigation commands and blocks known mutating/destructive patterns
- Delegated tasks receive an explicit read-only reconnaissance constraint
- Agent gathers evidence and creates a plan without making changes

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress

### Bash Guard

Investigation commands are allowed by default. This includes composed shell commands, project-specific inspection tools, and read-only Git commands such as `git -C <repo> status`, `git rev-parse`, `git grep`, `git blame`, `git log`, and `git diff`.

Known mutating commands remain blocked:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`, `git checkout`, `git switch`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`

The guard is intended to prevent accidental changes, not to serve as a security sandbox.
