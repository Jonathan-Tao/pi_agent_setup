# Plan Mode Extension

Plan mode provides read-only investigation followed by a single implementation handoff.

## Usage

1. Run `/plan`, press `Shift+Tab`, or press `Ctrl+Alt+P`.
2. Ask the agent to investigate a change.
3. The agent uses read-only tools and returns numbered steps under a `Plan:` heading.
4. Choose one of:
   - **Execute plan** — restore the exact pre-plan tool selection and implement with the full planning conversation available.
   - **Execute plan (clear planning context)** — start a fresh child session containing only the approved plan and an explicit implementation handoff.
   - **Stay in plan mode** — continue investigating or refine the plan with another prompt.
   - **Exit plan mode** — restore the exact pre-plan tool selection without implementing.

Use `/plan` again at any time to leave plan mode.

## Safety boundary

Plan mode enables only tools whose implementations are mechanically read-only:

- `read`
- `grep`
- `find`
- `ls`
- `question`
- `google_search`
- `pdf`

It disables shell execution, edits, writes, elevation, subagents, and unknown custom tools. This intentionally avoids shell denylisting and prompt-only restrictions, neither of which can guarantee read-only operation.

## Behavior

The extension does not parse plans into todos or manage implementation step-by-step. It does not use completion markers, progress widgets, context rewriting, or automatic per-step turns. The assistant-authored plan is handed back intact in one implementation prompt. During that execution turn, the system prompt explicitly states that plan mode is inactive so stale planning language cannot prevent implementation.

Automatic and manual compaction while executing an approved plan use the normal compaction implementation with extra summarizer instructions. The summary must preserve the complete plan, completed and remaining steps, changes, checks, decisions, blockers, and unresolved questions, and direct the continuing agent to resume implementation rather than return to planning. Compaction while still investigating in plan mode is unchanged.

The active tool selection from before plan mode is restored exactly, excluding tools that are no longer registered. Plan-mode and execution state and the prior tool selection survive session reloads and resumes.
