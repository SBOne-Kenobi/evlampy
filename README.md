# Evlampy

A deliberately **dumb, token-frugal LLM shell** for VS Code.

No agentic loop. The model does not read files, run commands, or write files one
by one. **You** assemble the context; the model answers in **one request**; diffs
are applied automatically into the right places, and you review them in VS Code's
native diff editors.

The whole philosophy: don't let the model do work it can't do well. It plans and
writes the change; you stay in control and validate.

## How it works

1. Open the **Evlampy** view in the activity bar.
2. Attach context fast:
   - `⌘/Ctrl+I` with no selection → adds the **whole open file**.
   - `⌘/Ctrl+I` with a selection → adds **just that range** (`path:start-end`).
   - Type `@` in the chat → fuzzy file picker (grep over workspace file names).
3. Type your request and hit **Enter**. Your prompt + attachments go in a single
   call to your OpenRouter (OpenAI-compatible) endpoint.
4. The reply streams in as Markdown. Any diff blocks are applied automatically and
   you **review them one file at a time** (linear review): the first changed file
   opens as an **original ↔ proposed** diff.
5. Decide per file — **✓ / ✗** buttons in the diff editor's title bar (or in the
   review list in the panel). ✓ accepts (saves), ✗ rejects (reverts). After each
   decision the next pending file opens automatically, until the review is complete.
   You can edit the proposed side before accepting. Works for files that weren't
   open before too.

If the model lacks context, it simply replies with text (e.g. suggests a command)
and emits no diffs. You run it. No loop.

**Conversation memory.** Within a chat, each message includes the previous turns,
so follow-ups have context. Use **New Chat** (the `+` in the view title) to reset
the context, and **History** (the clock icon) to restore one of the last 5 chats.
Resetting the context is your token-control lever.

## Diff format

The model is told to emit fenced blocks whose info string starts with `evlampy:`.
Everything else in the reply is just chat.

- `evlampy:edit <path>` — one or more git-conflict-style hunks:
  ```
  <<<<<<< SEARCH
  <verbatim, contiguous, UNIQUE lines from the file>
  =======
  <replacement>
  >>>>>>> REPLACE
  ```
- `evlampy:new <path>` — full content of a new file.
- `evlampy:rewrite <path>` — full new content (only when changes are pervasive).
- `evlampy:delete <path>` — delete a file (reject restores it).

Matching is three-level: **exact → whitespace-normalized → fuzzy** (Levenshtein
≥ 0.85). If a SEARCH is ambiguous (multiple matches) or no confident match is
found, that hunk is **not applied** and is reported in the chat — there's no loop
to recover, so you fix it by hand. Multiple hunks per file apply bottom-up and
are order-invariant.

This format is token-frugal (you pay only for the changed region, never the whole
file) and robust (the full old block is verifiable), following what Aider / Cline /
Roo-Code converged on. Notably **no line numbers** — every benchmark shows models
are bad at them.

## Config

`.evlampy/config.json` in the workspace (path overridable via the `evlampy.configPath`
setting). Run **Evlampy: Open Config** to scaffold it.

```json
{
  "userSystemPromptPath": ".evlampy/system.md",
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKey": "${env:OPENROUTER_API_KEY}",
  "models": ["qwen/qwen3-max", "deepseek/deepseek-chat"],
  "defaultModel": "qwen/qwen3-max",
  "provider": {},
  "reasoning": { "effort": "high" },
  "temperature": 0.3
}
```

- `apiKey` supports `${env:VAR}` so you don't commit secrets.
- `provider` and `reasoning` are passed **straight through** to OpenRouter — no
  invented format.
- `models` populates the picker; `userSystemPromptPath` is appended after Evlampy's
  minimal format prompt.

Cost (last request + chat total, in `$` and tokens) is shown in the composer, read
from the provider's `usage` (Evlampy requests `usage.include`).

## Develop

```bash
npm install
npm run build       # bundle extension + webview
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm run test:core   # parser + matcher sanity tests
```

Then press **F5** in VS Code (Run Evlampy Extension) to launch an Extension
Development Host.

## What Evlampy deliberately does NOT have

MCP, skills, roles, image input, agent loops, auto-commits, fancy settings. If you
want a "skill", keep a folder of `.md` files and `@`-attach one. That's the point.
