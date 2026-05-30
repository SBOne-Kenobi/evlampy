// Standalone sanity tests for parser + matcher (no vscode needed).
// Run: npm run test:core
import { parseDiffOps } from "../src/parser";
import { findMatch } from "../src/matcher";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`, extra ?? "");
  }
}

// ---- parser: edit with one hunk ----
{
  const resp = [
    "Here is the change.",
    "```evlampy:edit src/Foo.scala",
    "<<<<<<< SEARCH",
    "  val x = 1",
    "=======",
    "  val x = 2",
    ">>>>>>> REPLACE",
    "```",
    "Done.",
  ].join("\n");
  const ops = parseDiffOps(resp);
  check("one edit op parsed", ops.length === 1, ops);
  if (ops[0]?.kind === "edit") {
    check("hunk search", ops[0].hunks[0].search === "  val x = 1");
    check("hunk replace", ops[0].hunks[0].replace === "  val x = 2");
    check("path", ops[0].path === "src/Foo.scala");
  }
}

// ---- parser: multiple hunks + ignores normal code fences ----
{
  const resp = [
    "```python",
    "print('not an edit')",
    "```",
    "```evlampy:edit a.ts",
    "<<<<<<< SEARCH",
    "a",
    "=======",
    "A",
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "b",
    "=======",
    "B",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");
  const ops = parseDiffOps(resp);
  check("ignores plain fence; one edit", ops.length === 1, ops);
  if (ops[0]?.kind === "edit") {
    check("two hunks", ops[0].hunks.length === 2, ops[0].hunks);
  }
}

// ---- parser: 3-backtick edit wrapper with inner ``` (the qwen case) ----
{
  const resp = [
    "Updating the docs:",
    "```evlampy:edit docs/x.md", // only 3 backticks
    "<<<<<<< SEARCH",
    "Example:",
    "```bash",
    "old --flag",
    "```",
    "=======",
    "Example:",
    "```bash",
    "new --flag",
    "```",
    ">>>>>>> REPLACE",
    "```",
    "Done.",
  ].join("\n");
  const ops = parseDiffOps(resp);
  check("3-tick edit with inner fences: one op", ops.length === 1, ops);
  if (ops[0]?.kind === "edit") {
    check("inner ``` kept in search", ops[0].hunks[0].search === "Example:\n```bash\nold --flag\n```", JSON.stringify(ops[0].hunks[0].search));
    check("inner ``` kept in replace", ops[0].hunks[0].replace === "Example:\n```bash\nnew --flag\n```", JSON.stringify(ops[0].hunks[0].replace));
  }
}

// ---- parser: two hunks, 3-backtick wrapper, inner fences in first ----
{
  const resp = [
    "```evlampy:edit a.md",
    "<<<<<<< SEARCH",
    "```",
    "a",
    "```",
    "=======",
    "```",
    "A",
    "```",
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "plain b",
    "=======",
    "plain B",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");
  const ops = parseDiffOps(resp);
  check("two hunks despite inner fences", ops[0]?.kind === "edit" && ops[0].hunks.length === 2, ops);
}

// ---- parser: new + rewrite + delete ----
{
  const resp = [
    "```evlampy:new src/New.ts",
    "export const x = 1;",
    "```",
    "```evlampy:rewrite src/Old.ts",
    "export const y = 2;",
    "```",
    "```evlampy:delete src/Gone.ts",
    "```",
  ].join("\n");
  const ops = parseDiffOps(resp);
  check("three ops", ops.length === 3, ops.map((o) => o.kind));
  check("new content", ops[0].kind === "new" && ops[0].content === "export const x = 1;");
  check("delete kind", ops[2].kind === "delete");
}

// ---- matcher: exact unique ----
{
  const file = "line1\nline2\nTARGET\nline4\n";
  const r = findMatch(file, "TARGET");
  check("exact match ok", r.ok && r.match.level === "exact", r);
  if (r.ok) {
    check("exact span", file.slice(r.match.start, r.match.end) === "TARGET");
  }
}

// ---- matcher: ambiguous exact -> fail ----
{
  const file = "dup\nmiddle\ndup\n";
  const r = findMatch(file, "dup");
  check("ambiguous exact fails", !r.ok, r);
}

// ---- matcher: normalized (search has trailing whitespace the file lacks) ----
{
  const file = "alpha\n  beta\ngamma\n"; // clean
  const r = findMatch(file, "  beta   "); // model emitted trailing spaces
  check("normalized match ok", r.ok && r.match.level === "normalized", r);
  if (r.ok) {
    check("normalized span covers beta", file.slice(r.match.start, r.match.end).includes("beta"));
  }
}

// ---- matcher: fuzzy (one char off) ----
{
  const file = "function foo() {\n  return 42;\n}\n";
  const r = findMatch(file, "function foo() {\n  return 43;\n}");
  check("fuzzy match ok", r.ok && r.match.level === "fuzzy", r);
}

// ---- matcher: too different -> fail ----
{
  const file = "completely\nunrelated\ncontent\n";
  const r = findMatch(file, "xxxxxxx\nyyyyyyy\nzzzzzzz");
  check("no confident match fails", !r.ok, r);
}

// ---- end-to-end: apply a hunk via offsets ----
{
  const file = "header\nold body line\nfooter\n";
  const ops = parseDiffOps(
    [
      "```evlampy:edit f.txt",
      "<<<<<<< SEARCH",
      "old body line",
      "=======",
      "new body line",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n")
  );
  if (ops[0]?.kind === "edit") {
    const r = findMatch(file, ops[0].hunks[0].search);
    if (r.ok) {
      const applied = file.slice(0, r.match.start) + ops[0].hunks[0].replace + file.slice(r.match.end);
      check("applied result", applied === "header\nnew body line\nfooter\n", JSON.stringify(applied));
    } else {
      check("applied result", false, r);
    }
  }
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
