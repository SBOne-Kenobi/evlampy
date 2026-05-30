import { DiffOp, Hunk } from "./types";

/**
 * Extract Evlampy diff operations from an assistant message.
 *
 * We scan for fenced blocks whose info string starts with "evlampy:". The fence
 * may use 3+ backticks (the model can use longer fences if the body contains
 * backticks); we match the closing fence to the exact opening run length.
 */
export function parseDiffOps(text: string): DiffOp[] {
  const ops: DiffOp[] = [];
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    const open = matchOpenFence(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    i++; // move past the opening fence

    if (open.kind === "edit") {
      // Structure-aware: a ``` line only ends the block when we're BETWEEN
      // hunks, so backticks inside SEARCH/REPLACE bodies are treated as content
      // regardless of how many backticks the model used to open the block.
      const { hunks, next } = parseEditBody(lines, i, open.ticks);
      if (hunks.length) {
        ops.push({ kind: "edit", path: open.path, hunks });
      }
      i = next;
      continue;
    }

    // new / rewrite / delete: opaque body, closed by a fence of >= open length.
    const bodyLines: string[] = [];
    let closed = false;
    while (i < lines.length) {
      if (isCloseFence(lines[i], open.ticks)) {
        closed = true;
        break;
      }
      bodyLines.push(lines[i]);
      i++;
    }
    const op = toOp(open.kind, open.path, bodyLines.join("\n"));
    if (op) {
      ops.push(op);
    }
    if (closed) {
      i++;
    }
  }
  return ops;
}

/**
 * Parse the body of an `evlampy:edit` block as a sequence of SEARCH/REPLACE
 * hunks. Fence lines are honored only while between hunks; inside a SEARCH or
 * REPLACE body they are literal content. Returns the hunks and the line index
 * just past the closing fence (or EOF).
 */
function parseEditBody(
  lines: string[],
  start: number,
  openTicks: string
): { hunks: Hunk[]; next: number } {
  const hunks: Hunk[] = [];
  let mode: "between" | "search" | "replace" = "between";
  let search: string[] = [];
  let replace: string[] = [];
  let i = start;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (mode === "between") {
      if (isCloseFence(line, openTicks)) {
        i++; // consume the closing fence
        break;
      }
      if (SEARCH_RE.test(line)) {
        mode = "search";
        search = [];
      }
      // Other lines between hunks (blank/stray) are ignored.
    } else if (mode === "search") {
      if (SEP_RE.test(line)) {
        mode = "replace";
        replace = [];
      } else {
        search.push(line);
      }
    } else {
      // replace
      if (REPLACE_RE.test(line)) {
        hunks.push({ search: search.join("\n"), replace: replace.join("\n") });
        mode = "between";
      } else {
        replace.push(line);
      }
    }
  }

  // Tolerate a final hunk whose closing >>>>>>> REPLACE was omitted.
  if (mode === "replace") {
    hunks.push({ search: search.join("\n"), replace: replace.join("\n") });
  }
  return { hunks, next: i };
}

interface OpenFence {
  ticks: string;
  kind: string;
  path: string;
}

function matchOpenFence(line: string): OpenFence | undefined {
  // e.g.  ```evlampy:edit src/foo.ts
  const m = /^(\s*)(`{3,})\s*evlampy:([a-zA-Z]+)\s+(.+?)\s*$/.exec(line);
  if (!m) {
    return undefined;
  }
  return { ticks: m[2], kind: m[3].toLowerCase(), path: m[4].trim() };
}

function isCloseFence(line: string, openTicks: string): boolean {
  // CommonMark: a fence closes on a line with at least as many backticks as the
  // opener. This lets the model wrap content that itself contains ``` by opening
  // with a longer run (e.g. ````), so inner ``` lines don't close the block early.
  return new RegExp(`^\\s*\`{${openTicks.length},}\\s*$`).test(line);
}

function toOp(kind: string, path: string, body: string): DiffOp | undefined {
  switch (kind) {
    case "new":
      return { kind: "new", path, content: stripTrailingNewline(body) };
    case "rewrite":
      return { kind: "rewrite", path, content: stripTrailingNewline(body) };
    case "delete":
      return { kind: "delete", path };
    default:
      return undefined;
  }
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\n$/, "");
}

const SEARCH_RE = /^<{5,}\s*SEARCH\s*$/;
const SEP_RE = /^={5,}\s*$/;
const REPLACE_RE = /^>{5,}\s*REPLACE\s*$/;

/** Parse one or more git-conflict-style SEARCH/REPLACE hunks. */
export function parseHunks(body: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!SEARCH_RE.test(lines[i])) {
      i++;
      continue;
    }
    i++; // past <<<<<<< SEARCH
    const search: string[] = [];
    while (i < lines.length && !SEP_RE.test(lines[i])) {
      search.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      break; // malformed, no separator
    }
    i++; // past =======
    const replace: string[] = [];
    while (i < lines.length && !REPLACE_RE.test(lines[i])) {
      replace.push(lines[i]);
      i++;
    }
    if (i < lines.length) {
      i++; // past >>>>>>> REPLACE
    }
    hunks.push({ search: search.join("\n"), replace: replace.join("\n") });
  }
  return hunks;
}

/** Strip placeholder "... existing code ..." lines as a defensive measure. */
export function stripPlaceholders(code: string): string {
  return code
    .split("\n")
    .filter(
      (l) =>
        !/^\s*(\/\/|#|--|\/\*|\*)?\s*\.\.\.\s*existing code\s*\.\.\.\s*(\*\/)?\s*$/i.test(
          l
        )
    )
    .join("\n");
}
