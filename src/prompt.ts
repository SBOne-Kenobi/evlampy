import { Attachment } from "./types";

/**
 * The ONLY system prompt Evlampy injects on its own. It exists solely to teach
 * the model the diff format the shell can apply. No personality, no agent rules.
 */
export const DEFAULT_SYSTEM_PROMPT = `To change files, emit fenced code blocks whose info string begins with "evlampy:".
Only those blocks are applied to the files; all other text is shown to the user as-is.

EDIT an existing file (preferred — cheapest):
\`\`\`evlampy:edit relative/path/to/File.ext
<<<<<<< SEARCH
<exact, verbatim, CONTIGUOUS lines copied from the file>
=======
<the replacement lines>
>>>>>>> REPLACE
\`\`\`
You may put several SEARCH/REPLACE hunks in one edit block (one after another).

CREATE a new file:
\`\`\`evlampy:new relative/path/to/File.ext
<full file contents>
\`\`\`

REWRITE a whole file (only when changes are pervasive):
\`\`\`evlampy:rewrite relative/path/to/File.ext
<full new contents>
\`\`\`

DELETE a file:
\`\`\`evlampy:delete relative/path/to/File.ext
\`\`\`

RULES — follow exactly:
- The SEARCH text must be copied VERBATIM from the provided file, including indentation and
  whitespace. It must be UNIQUE in that file. If a single line is not unique (e.g. a lone "}"),
  include a few adjacent lines so the match is unambiguous. Otherwise keep SEARCH as small as possible.
- NEVER write placeholder comments like "// ... existing code ...". Output real code only.
- NEVER include line numbers in the code.
- Put the file path in the info string (after the ":"), never above the fence.
- Prefer evlampy:edit over evlampy:rewrite to save tokens.
- If you lack the files or information to make the change safely, DO NOT guess: say what you need,
  or suggest a command for the user to run, and emit no edit blocks.`;

/** Compose the full system message: our format prompt, then the user's own rules. */
export function buildSystemMessage(userSystemPrompt: string): string {
  if (!userSystemPrompt.trim()) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  return `${DEFAULT_SYSTEM_PROMPT}\n\n---\n\n${userSystemPrompt.trim()}`;
}

function fence(content: string): string {
  // Choose a fence long enough not to collide with backticks inside the content.
  let ticks = "```";
  while (content.includes(ticks)) {
    ticks += "`";
  }
  return ticks;
}

/** Render one attachment as a labeled, fenced block. */
function renderAttachment(a: Attachment): string {
  const f = fence(a.content);
  const header =
    a.range
      ? `File ${a.path} (lines ${a.range.startLine}-${a.range.endLine}):`
      : `File ${a.path}:`;
  return `${header}\n${f}\n${a.content}\n${f}`;
}

/** Compose the user message: attachments first (as context), then the prompt. */
export function buildUserMessage(
  text: string,
  attachments: Attachment[]
): string {
  if (attachments.length === 0) {
    return text;
  }
  const ctx = attachments.map(renderAttachment).join("\n\n");
  return `${ctx}\n\n---\n\n${text}`;
}
