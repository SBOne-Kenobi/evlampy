import * as vscode from "vscode";
import * as path from "path";
import { DiffManager } from "./applier";
import { chat } from "./openrouter";
import { loadConfig, loadUserSystemPrompt, ConfigError } from "./config";
import { buildSystemMessage, buildUserMessage } from "./prompt";
import { parseDiffOps } from "./parser";
import { Attachment, FromWebview, ToWebview } from "./types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "evlampy.chatView";
  private view?: vscode.WebviewView;
  private abort?: AbortController;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diffs: DiffManager
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  /** Reveal the chat and push an attachment chip (from the Cmd+I command). */
  async addAttachment(attachment: Attachment): Promise<void> {
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    // Give the view a tick to resolve if it was hidden.
    await new Promise((r) => setTimeout(r, 50));
    this.post({ type: "addAttachment", attachment });
  }

  private post(msg: ToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        return this.sendInit();
      case "send":
        return this.runChat(m.text, m.attachments, m.model);
      case "requestFileSuggestions":
        return this.sendFileSuggestions(m.query);
      case "acceptAll": {
        const n = await this.diffs.acceptAll();
        this.post({ type: "status", text: `Accepted ${n} file(s).` });
        return;
      }
      case "rejectAll": {
        const n = await this.diffs.rejectAll();
        this.post({ type: "status", text: `Reverted ${n} file(s).` });
        return;
      }
      case "openConfig":
        return void vscode.commands.executeCommand("evlampy.openConfig");
      case "removeAttachment":
        return; // attachment state lives in the webview; nothing to do here
    }
  }

  private async sendInit(): Promise<void> {
    try {
      const cfg = await loadConfig();
      this.post({
        type: "init",
        models: cfg.models,
        defaultModel: cfg.defaultModel ?? cfg.models[0],
      });
    } catch (e) {
      // Still init with empty models; surface the config problem.
      this.post({ type: "init", models: [], defaultModel: "" });
      this.post({ type: "error", message: (e as Error).message });
    }
  }

  private async runChat(
    text: string,
    attachments: Attachment[],
    model: string
  ): Promise<void> {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      const msg =
        e instanceof ConfigError
          ? e.message
          : `Failed to load config: ${(e as Error).message}`;
      this.post({ type: "error", message: msg });
      this.post({ type: "assistantDone" });
      return;
    }

    const userSystem = await loadUserSystemPrompt(cfg);
    const system = buildSystemMessage(userSystem);
    const user = buildUserMessage(text, attachments);

    this.abort = new AbortController();
    this.post({ type: "assistantStart" });

    let full = "";
    let usage;
    try {
      const res = await chat({
        config: cfg,
        model: model || cfg.defaultModel || cfg.models[0],
        system,
        user,
        signal: this.abort.signal,
        onDelta: (d) => {
          full += d;
          this.post({ type: "assistantDelta", text: d });
        },
      });
      usage = res.usage;
      full = res.text || full;
    } catch (e) {
      this.post({
        type: "error",
        message: `Request failed: ${(e as Error).message}`,
      });
      this.post({ type: "assistantDone" });
      return;
    }

    // Parse + apply diffs from the completed message.
    const ops = parseDiffOps(full);
    if (ops.length > 0) {
      this.post({ type: "status", text: `Applying ${ops.length} change(s)…` });
      const report = await this.diffs.apply(ops);
      this.post({ type: "applyReport", report });
    }

    this.post({ type: "assistantDone", usage });
  }

  private async sendFileSuggestions(query: string): Promise<void> {
    const q = query.toLowerCase();
    const found = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,out,.git}/**",
      2000
    );
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const items = found
      .map((u) => path.relative(root, u.fsPath).replace(/\\/g, "/"))
      .filter((p) => p.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefer matches on the basename, then shorter paths.
        const ab = path.basename(a).toLowerCase().includes(q) ? 0 : 1;
        const bb = path.basename(b).toLowerCase().includes(q) ? 0 : 1;
        return ab - bb || a.length - b.length;
      })
      .slice(0, 20);
    this.post({ type: "fileSuggestions", query, items });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Evlampy</title>
</head>
<body>
  <div id="messages"></div>
  <div id="attachments"></div>
  <div id="suggestions" class="hidden"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Ask…  (@ to attach a file, ⌘/Ctrl+I to add the open file/selection)"></textarea>
    <div id="controls">
      <select id="model" title="Model"></select>
      <span id="cost" class="cost"></span>
      <button id="send" title="Send (Enter)">Send</button>
    </div>
    <div id="diffbar" class="hidden">
      <span id="diffsummary"></span>
      <button id="accept" class="accept">Accept all</button>
      <button id="reject" class="reject">Reject all</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let s = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
