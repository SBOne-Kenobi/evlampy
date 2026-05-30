import * as vscode from "vscode";
import * as path from "path";
import { ApplyReport, ApplyResultItem, DiffOp, Hunk } from "./types";
import { findMatch } from "./matcher";
import { stripPlaceholders } from "./parser";

const ORIG_SCHEME = "evlampy-orig";

interface PendingFile {
  uri: vscode.Uri;
  /** Original on-disk content; null if the file was newly created. */
  original: string | null;
  /** True if the op deleted the file (already removed from disk). */
  deleted: boolean;
}

/**
 * Applies diff ops to documents (leaving them dirty), opens native diff views,
 * and tracks pending changes so the whole batch can be accepted (saved) or
 * rejected (reverted) at once — including files that weren't open before.
 */
export class DiffManager implements vscode.TextDocumentContentProvider {
  private pending = new Map<string, PendingFile>();
  private originals = new Map<string, string>();
  private counter = 0;

  constructor(private readonly root: string) {}

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.originals.get(uri.toString()) ?? "";
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private resolve(rel: string): vscode.Uri {
    const abs = path.isAbsolute(rel) ? rel : path.join(this.root, rel);
    return vscode.Uri.file(abs);
  }

  async apply(ops: DiffOp[]): Promise<ApplyReport> {
    const items: ApplyResultItem[] = [];
    // Reset previous batch tracking (a new response supersedes it).
    this.pending.clear();
    this.originals.clear();

    for (const op of ops) {
      try {
        const item = await this.applyOne(op);
        items.push(item);
      } catch (e) {
        items.push({ path: op.path, ok: false, detail: (e as Error).message });
      }
    }

    const appliedCount = items.filter((i) => i.ok).length;
    return { items, appliedCount, failedCount: items.length - appliedCount };
  }

  private async applyOne(op: DiffOp): Promise<ApplyResultItem> {
    switch (op.kind) {
      case "new":
        return this.applyNew(op.path, op.content);
      case "rewrite":
        return this.applyRewrite(op.path, op.content);
      case "edit":
        return this.applyEdit(op.path, op.hunks);
      case "delete":
        return this.applyDelete(op.path);
    }
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async applyNew(rel: string, content: string): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    if (await this.exists(uri)) {
      // Fall back to a full rewrite if the model used `new` on an existing file.
      return this.applyRewrite(rel, content);
    }
    const we = new vscode.WorkspaceEdit();
    we.createFile(uri, { ignoreIfExists: true });
    we.insert(uri, new vscode.Position(0, 0), content);
    await vscode.workspace.applyEdit(we);
    this.track(uri, null, false);
    await this.openDiff(uri, "", rel);
    return { path: rel, ok: true, detail: "new file" };
  }

  private async applyRewrite(rel: string, content: string): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();
    await this.replaceWhole(doc, content);
    this.track(uri, original, false);
    await this.openDiff(uri, original, rel);
    return { path: rel, ok: true, detail: "rewritten" };
  }

  private async applyEdit(rel: string, hunks: Hunk[]): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();

    // Find every hunk against the ORIGINAL text, then splice bottom-up.
    interface Span { start: number; end: number; replace: string; }
    const spans: Span[] = [];
    const failures: string[] = [];

    for (let h = 0; h < hunks.length; h++) {
      const hunk = hunks[h];
      const outcome = findMatch(original, hunk.search);
      if (!outcome.ok) {
        failures.push(`hunk ${h + 1}: ${outcome.reason}`);
        continue;
      }
      spans.push({
        start: outcome.match.start,
        end: outcome.match.end,
        replace: stripPlaceholders(hunk.replace),
      });
    }

    spans.sort((a, b) => b.start - a.start);
    // Drop overlapping spans (keep the later one already placed).
    let lastStart = Number.MAX_SAFE_INTEGER;
    let newText = original;
    for (const s of spans) {
      if (s.end > lastStart) {
        failures.push("overlapping hunks; one was skipped");
        continue;
      }
      newText = newText.slice(0, s.start) + s.replace + newText.slice(s.end);
      lastStart = s.start;
    }

    const appliedHunks = spans.length - failures.filter((f) => f.includes("overlapping")).length;
    if (newText !== original) {
      await this.replaceWhole(doc, newText);
      this.track(uri, original, false);
      await this.openDiff(uri, original, rel);
    }

    if (failures.length > 0) {
      const okPart = appliedHunks > 0 ? `${appliedHunks} hunk(s) applied; ` : "";
      return {
        path: rel,
        ok: appliedHunks > 0,
        detail: `${okPart}${failures.length} failed — ${failures.join("; ")}`,
      };
    }
    return { path: rel, ok: true, detail: `${hunks.length} hunk(s) applied` };
  }

  private async applyDelete(rel: string): Promise<ApplyResultItem> {
    const uri = this.resolve(rel);
    if (!(await this.exists(uri))) {
      return { path: rel, ok: false, detail: "file does not exist" };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();
    const we = new vscode.WorkspaceEdit();
    we.deleteFile(uri, { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(we);
    this.track(uri, original, true);
    return { path: rel, ok: true, detail: "deleted (reject to restore)" };
  }

  private track(uri: vscode.Uri, original: string | null, deleted: boolean): void {
    const key = uri.toString();
    if (!this.pending.has(key)) {
      this.pending.set(key, { uri, original, deleted });
    }
  }

  private async replaceWhole(doc: vscode.TextDocument, content: string): Promise<void> {
    const we = new vscode.WorkspaceEdit();
    const full = new vscode.Range(
      new vscode.Position(0, 0),
      doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end
    );
    we.replace(doc.uri, full, content);
    await vscode.workspace.applyEdit(we);
  }

  private async openDiff(fileUri: vscode.Uri, original: string, label: string): Promise<void> {
    const origUri = vscode.Uri.parse(
      `${ORIG_SCHEME}:${label}?v=${this.counter++}`
    );
    this.originals.set(origUri.toString(), original);
    await vscode.commands.executeCommand(
      "vscode.diff",
      origUri,
      fileUri,
      `${label} (Evlampy: original ↔ proposed)`,
      { preview: false }
    );
  }

  /** Save every pending file: the changes become permanent. */
  async acceptAll(): Promise<number> {
    let n = 0;
    for (const p of this.pending.values()) {
      if (p.deleted) {
        n++;
        continue; // already removed from disk
      }
      const doc = await vscode.workspace.openTextDocument(p.uri);
      if (doc.isDirty) {
        await doc.save();
      }
      n++;
    }
    this.pending.clear();
    this.originals.clear();
    return n;
  }

  /** Revert every pending file back to its original on-disk state. */
  async rejectAll(): Promise<number> {
    let n = 0;
    for (const p of this.pending.values()) {
      if (p.deleted && p.original !== null) {
        // Recreate the deleted file.
        const we = new vscode.WorkspaceEdit();
        we.createFile(p.uri, { ignoreIfExists: true });
        we.insert(p.uri, new vscode.Position(0, 0), p.original);
        await vscode.workspace.applyEdit(we);
        n++;
        continue;
      }
      if (p.original === null) {
        // Was newly created: delete it.
        const we = new vscode.WorkspaceEdit();
        we.deleteFile(p.uri, { ignoreIfNotExists: true });
        await vscode.workspace.applyEdit(we);
        n++;
        continue;
      }
      const doc = await vscode.workspace.openTextDocument(p.uri);
      await this.replaceWhole(doc, p.original);
      if (doc.isDirty) {
        await doc.save();
      }
      n++;
    }
    this.pending.clear();
    this.originals.clear();
    return n;
  }
}
