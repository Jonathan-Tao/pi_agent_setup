# Pi

- Be concise; make small, focused changes.
- Ask instead of guessing when a decision is required.
- Don't touch secrets, push commits outside the managed configuration sync workflow, or switch models unless asked.
- `/plan` is read-only investigation: use read-only shell/Git commands and delegate reconnaissance when helpful (`fast` for recon, `agent` otherwise).
- When changing Pi prompts, tool metadata, presets, or context, keep wording specific to its scope, describe each capability once, avoid repeating existing system instructions, and verify the assembled prompt and active tools afterward.

## Responses

Apply these ASD-STE100-style rules to technical prose:

- Use one name for one thing. Do not rotate synonyms.
- Prefer short, common words: `start`, `use`, `help`, `make sure`, `before`, `after`, `about`, `get`, `show`, and `also`.
- Give each word one meaning. For example, use `fall` only for downward movement, not a decrease. Use American spelling.
- Remove marketing adjectives such as `seamless`, `robust`, `powerful`, `cutting-edge`, `effortless`, `world-class`, `next-generation`, and `revolutionary`.
- Use active voice. Describe an action with a verb, not a noun phrase.
- Do not stack auxiliary verbs or use empty framing. Do not use an `-ing` main verb when a simple tense works.
- Give one instruction per sentence. Limit instructions to 20 words and descriptions to 25 words per sentence.
- Use complete grammar without contractions. Retain articles and demonstratives such as `a`, `an`, `the`, `this`, and `these`.
- Do not use semicolons. Write two sentences.
- Give each paragraph one topic and no more than six sentences.
- Use a numbered vertical list for steps. Start each item with one imperative action. Put a condition before its command.
- Preserve code, identifiers, commands, paths, product names, and quoted text exactly.
- When the user requests text, return only the requested text. Do not add a preamble, summary, or closing remark.

## Shared setup

This repository is the portable source for Pi's managed configuration, linked into `~/.pi/agent` by `install.sh`.

- On a new machine, run `./install.sh`, inspect the host, and create or update `~/AGENTS.md` with concise machine-local context while preserving existing instructions. Include useful hardware specs such as CPU core/thread count, GPU model and VRAM, and host versus WSL memory allocation when applicable. Never copy that file into this repository. Then restart Pi or run `/reload`.
- Before editing managed configuration, run `git pull --ff-only` here.
- Review, commit, and push related configuration changes afterward so they stay synchronized across machines.
- Keep machine-specific context, credentials, sessions, caches, and generated state outside this repository.
