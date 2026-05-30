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
    // Collect body until a closing fence of the same backtick length.
    const bodyLines: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (isCloseFence(lines[j], open.ticks)) {
        closed = true;
        break;
      }
      bodyLines.push(lines[j]);
      j++;
    }
    const op = toOp(open.kind, open.path, bodyLines.join("\n"));
    if (op) {
      ops.push(op);
    }
    i = closed ? j + 1 : j;
  }
  return ops;
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
    case "edit": {
      const hunks = parseHunks(body);
      return hunks.length ? { kind: "edit", path, hunks } : undefined;
    }
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
