// Locating a SEARCH block inside a file: exact -> normalized -> fuzzy.
// Ambiguity (multiple equally-good matches) is reported as a failure, never
// applied silently — there is no agent loop to recover from a wrong guess.

export interface MatchResult {
  /** Character offset (inclusive) where the match starts in the file. */
  start: number;
  /** Character offset (exclusive) where the match ends. */
  end: number;
  /** How it was matched, for reporting. */
  level: "exact" | "normalized" | "fuzzy";
  score: number;
}

export type MatchOutcome =
  | { ok: true; match: MatchResult }
  | { ok: false; reason: string };

const FUZZY_THRESHOLD = 0.85;
/** Best fuzzy candidate must beat the runner-up by this margin to be unambiguous. */
const FUZZY_MARGIN = 0.05;

function normalizeLine(line: string): string {
  return line.replace(/\s+$/, "");
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(normalizeLine)
    .join("\n");
}

/** All occurrences of `needle` in `haystack` (non-overlapping). */
function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) {
    return out;
  }
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) {
      break;
    }
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

export function findMatch(fileText: string, search: string): MatchOutcome {
  if (search.trim() === "") {
    return { ok: false, reason: "empty SEARCH block" };
  }

  // 1) Exact.
  const exact = findAll(fileText, search);
  if (exact.length === 1) {
    return {
      ok: true,
      match: {
        start: exact[0],
        end: exact[0] + search.length,
        level: "exact",
        score: 1,
      },
    };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      reason: `SEARCH matches ${exact.length} places exactly; not unique. Add surrounding context.`,
    };
  }

  // 2) Normalized (trailing whitespace + CRLF). Map back to original offsets via line search.
  const normFile = normalize(fileText);
  const normSearch = normalize(search);
  const normHits = findAll(normFile, normSearch);
  if (normHits.length === 1) {
    const span = mapNormalizedToOriginal(fileText, normFile, normHits[0], normSearch.length);
    if (span) {
      return { ok: true, match: { ...span, level: "normalized", score: 1 } };
    }
  } else if (normHits.length > 1) {
    return {
      ok: false,
      reason: `SEARCH matches ${normHits.length} places after whitespace normalization; not unique.`,
    };
  }

  // 3) Fuzzy over a sliding window of equal line-count.
  return fuzzyMatch(fileText, search);
}

/**
 * Map a match found in the normalized text back to a character span in the
 * original text by walking both line-by-line.
 */
function mapNormalizedToOriginal(
  original: string,
  normalized: string,
  normStart: number,
  normLen: number
): { start: number; end: number } | undefined {
  // Count lines before normStart and lines covered by the match.
  const linesBefore = countLines(normalized, normStart);
  const matchLineCount = countLines(normalized, normStart + normLen) - linesBefore + 1;

  const origLines = original.split("\n");
  if (linesBefore + matchLineCount > origLines.length) {
    return undefined;
  }
  let start = 0;
  for (let k = 0; k < linesBefore; k++) {
    start += origLines[k].length + 1;
  }
  let end = start;
  for (let k = 0; k < matchLineCount; k++) {
    end += origLines[linesBefore + k].length + 1;
  }
  // end currently includes a trailing newline that may not exist on the last line.
  end = Math.min(end, original.length);
  if (end > start && original[end - 1] === "\n") {
    end -= 1;
  }
  return { start, end };
}

function countLines(text: string, offset: number): number {
  let n = 0;
  for (let k = 0; k < offset && k < text.length; k++) {
    if (text[k] === "\n") {
      n++;
    }
  }
  return n;
}

function fuzzyMatch(fileText: string, search: string): MatchOutcome {
  const fileLines = fileText.split("\n");
  const searchLines = normalize(search).split("\n");
  const win = searchLines.length;
  if (win > fileLines.length) {
    return { ok: false, reason: "SEARCH has more lines than the file." };
  }
  const normFileLines = fileLines.map(normalizeLine);
  const target = searchLines.map(normalizeLine).join("\n");

  let best = -1;
  let bestScore = 0;
  let second = 0;
  for (let s = 0; s + win <= normFileLines.length; s++) {
    const candidate = normFileLines.slice(s, s + win).join("\n");
    const score = similarity(candidate, target);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = s;
    } else if (score > second) {
      second = score;
    }
  }

  if (best === -1 || bestScore < FUZZY_THRESHOLD) {
    return {
      ok: false,
      reason: `no confident match (best similarity ${(bestScore * 100).toFixed(0)}%). The file may have changed.`,
    };
  }
  if (bestScore - second < FUZZY_MARGIN) {
    return {
      ok: false,
      reason: `ambiguous fuzzy match (two regions score ~${(bestScore * 100).toFixed(0)}%). Add more context.`,
    };
  }

  // Convert line window to char offsets in the original text.
  let start = 0;
  for (let k = 0; k < best; k++) {
    start += fileLines[k].length + 1;
  }
  let end = start;
  for (let k = 0; k < win; k++) {
    end += fileLines[best + k].length + 1;
  }
  end = Math.min(end, fileText.length);
  if (end > start && fileText[end - 1] === "\n") {
    end -= 1;
  }
  return { ok: true, match: { start, end, level: "fuzzy", score: bestScore } };
}

/** Normalized Levenshtein similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) {
    return 1;
  }
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
