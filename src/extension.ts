import * as vscode from "vscode";
import * as path from "path";
import { ChatViewProvider } from "./chatViewProvider";
import { DiffManager } from "./applier";
import { ensureConfigScaffold } from "./config";
import { Attachment } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const diffs = new DiffManager(root);
  context.subscriptions.push(diffs.register());

  const provider = new ChatViewProvider(context, diffs);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("evlampy.addToChat", () =>
      addToChat(provider, root)
    ),
    vscode.commands.registerCommand("evlampy.focusChat", () =>
      vscode.commands.executeCommand("evlampy.chatView.focus")
    ),
    vscode.commands.registerCommand("evlampy.acceptAll", async () => {
      const n = await diffs.acceptAll();
      vscode.window.setStatusBarMessage(`Evlampy: accepted ${n} file(s)`, 3000);
    }),
    vscode.commands.registerCommand("evlampy.rejectAll", async () => {
      const n = await diffs.rejectAll();
      vscode.window.setStatusBarMessage(`Evlampy: reverted ${n} file(s)`, 3000);
    }),
    vscode.commands.registerCommand("evlampy.openConfig", async () => {
      try {
        await ensureConfigScaffold();
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    })
  );
}

async function addToChat(
  provider: ChatViewProvider,
  root: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Evlampy: no active editor.");
    return;
  }
  const doc = editor.document;
  const rel = root
    ? path.relative(root, doc.uri.fsPath).replace(/\\/g, "/")
    : doc.uri.fsPath;

  const sel = editor.selection;
  let attachment: Attachment;
  if (!sel.isEmpty) {
    const text = doc.getText(sel);
    attachment = {
      path: rel,
      range: { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
      content: text,
    };
  } else {
    attachment = { path: rel, content: doc.getText() };
  }
  await provider.addAttachment(attachment);
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
