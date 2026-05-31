import * as crypto from "crypto";
import * as vscode from "vscode";
import * as path from "path";
import { DiffManager } from "./applier";
import { chat } from "./openrouter";
import {
  configFilePath,
  loadConfig,
  loadUserSystemPrompt,
  ConfigError,
} from "./config";
import { buildSystemMessage, buildUserMessage } from "./prompt";
import { parseDiffOps } from "./parser";
 import {
   Attachment,
   ChatMsg,
   ChatSession,
   ConvTurn,
   EffortLevel,
   FromWebview,
   ToWebview,
 } from "./types";

const HISTORY_KEY = "evlampy.history";
const HISTORY_LIMIT = 5;
const SEARCH_EXCLUDE_DIRS = [
  ".*", "node_modules", "dist", "out", "build", "target", "bin",
  "obj", "coverage", "pycache", "venv", "env", "vendor", "cdk.out"
];

 export class ChatViewProvider implements vscode.WebviewViewProvider {
   public static readonly viewType = "evlampy.chatView";
   private view?: vscode.WebviewView;
   private abort?: AbortController;
   private configWatcher?: vscode.FileSystemWatcher;
   private configRefreshTimer?: ReturnType<typeof setTimeout>;

  // Current conversation (source of truth for what's sent to the model).
  private turns: ConvTurn[] = [];
  private sessionId = newId();
  private totalCost = 0;
  private totalTokens = 0;
  private pendingAttachments: Attachment[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diffs: DiffManager
  ) {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("evlampy.configPath")) {
          this.resetConfigWatcher();
        }
        this.scheduleConfigRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isConfigFile(doc.uri)) {
          this.scheduleConfigRefresh();
        }
      }),
      {
        dispose: () => {
          this.configWatcher?.dispose();
          if (this.configRefreshTimer) {
            clearTimeout(this.configRefreshTimer);
          }
        },
      }
    );
    this.resetConfigWatcher();
  }

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
    const isDup = this.pendingAttachments.some(
      (a) =>
        a.path === attachment.path &&
        a.range?.startLine === attachment.range?.startLine &&
        a.range?.endLine === attachment.range?.endLine
    );
    if (isDup) {
      return;
    }
    this.pendingAttachments.push(attachment);
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
        return this.runChat(m.text, m.attachments, m.model, m.effort);
      case "requestFileSuggestions":
        return this.sendFileSuggestions(m.query);
      case "attachByPath":
        return this.attachByPath(m.path);
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
    model: string,
    effort: EffortLevel
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

    this.pendingAttachments = [];
    this.turns.push({
      role: "user",
      text: buildUserMessage(text, attachments)
    });

    const messages: ChatMsg[] = [
      { role: "system", content: system },
      ...this.turns.map((t) => ({
        role: t.role,
        content: t.text
      })),
    ];

    this.abort = new AbortController();
    this.post({ type: "assistantStart" });

    let full;
    let usage;
    try {
      const res = await chat({
        config: cfg,
        model: model || cfg.defaultModel || cfg.models[0],
        effort,
        messages,
        signal: this.abort.signal,
        onDelta: (d) => {
          this.post({ type: "assistantDelta", text: d });
        },
      });
      usage = res.usage;
      full = res.text;
    } catch (e) {
      // Roll back the user turn so a failed request doesn't poison the context.
      this.turns.pop();
      this.post({
        type: "error",
        message: `Request failed: ${(e as Error).message}`,
      });
      this.post({ type: "assistantDone" });
      return;
    }

    this.turns.push({ role: "assistant", text: full });
    if (usage) {
      this.totalTokens += usage.totalTokens;
      if (usage.cost) {
        this.totalCost += usage.cost;
      }
    }
    await this.saveSession();

    // Parse + apply diffs from the completed message.
    const ops = parseDiffOps(full);
    if (ops.length > 0) {
      const report = await this.diffs.apply(ops);
      this.post({ type: "applyReport", report });
    }

    this.post({ type: "assistantDone", usage });
  }

  // ---- New chat + history ----

  async newChat(): Promise<void> {
    await this.saveSession();
    this.turns = [];
    this.sessionId = newId();
    this.totalCost = 0;
    this.totalTokens = 0;
    this.pendingAttachments = [];
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    this.post({ type: "clearChat" });
  }

  async showHistory(): Promise<void> {
    const sessions = this.loadHistory();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("Evlampy: no chat history yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title || "(untitled)",
        description: `${s.turns.filter((t) => t.role === "user").length} msg · ${fmtCost(s.totalCost)}`,
        detail: new Date(s.updatedAt).toLocaleString(),
        session: s,
      })),
      { placeHolder: "Restore a chat" }
    );
    if (pick) {
      await this.restore(pick.session);
    }
  }

  private async restore(s: ChatSession): Promise<void> {
    await this.saveSession(); // don't lose the current one
    this.turns = s.turns.map((t) => ({ ...t }));
    this.sessionId = s.id;
    this.totalCost = s.totalCost;
    this.totalTokens = s.totalTokens;
    await vscode.commands.executeCommand("evlampy.chatView.focus");
    this.post({
      type: "loadChat",
      turns: this.turns.map((t) => ({ role: t.role, text: t.text })),
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
    });
  }

  private loadHistory(): ChatSession[] {
    return this.context.workspaceState.get<ChatSession[]>(HISTORY_KEY, []);
  }

  /** Upsert the current session into history (most-recent first, capped). */
  private async saveSession(): Promise<void> {
    if (this.turns.length === 0) {
      return;
    }
    const firstUser = this.turns.find((t) => t.role === "user");
    const session: ChatSession = {
      id: this.sessionId,
      title: (firstUser?.text ?? "Chat").slice(0, 60),
      turns: this.turns.map((t) => ({ ...t })),
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      updatedAt: Date.now(),
    };
    const list = this.loadHistory().filter((s) => s.id !== session.id);
    list.unshift(session);
    await this.context.workspaceState.update(
      HISTORY_KEY,
      list.slice(0, HISTORY_LIMIT)
    );
  }

  /** Read a workspace file picked via @ and add it to the chat as an attachment. */
  private async attachByPath(rel: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      const content = Buffer.from(bytes).toString("utf8");
      this.post({ type: "addAttachment", attachment: { path: rel, content } });
    } catch {
      this.post({ type: "error", message: `Cannot read file: ${rel}` });
    }
  }

  private async sendFileSuggestions(query: string): Promise<void> {
    const q = query.toLowerCase();
    const found = await vscode.workspace.findFiles(
      "**/*",
      `**/{${SEARCH_EXCLUDE_DIRS.join(",")}}/**`,
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

  private resetConfigWatcher(): void {
    this.configWatcher?.dispose();
    this.configWatcher = undefined;

    let file: string;
    try {
      file = configFilePath();
    } catch {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalizedFile = path.normalize(file);
    let pattern: vscode.GlobPattern = normalizedFile.replace(/\\/g, "/");

    if (root) {
      const normalizedRoot = path.normalize(root);
      const rel = path.relative(normalizedRoot, normalizedFile);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        pattern = new vscode.RelativePattern(root, rel.replace(/\\/g, "/"));
      }
    }

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => this.scheduleConfigRefresh();
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.configWatcher = watcher;
  }

  private scheduleConfigRefresh(): void {
    if (this.configRefreshTimer) {
      clearTimeout(this.configRefreshTimer);
    }
    this.configRefreshTimer = setTimeout(() => {
      void this.sendInit();
    }, 150);
  }

  private isConfigFile(uri: vscode.Uri): boolean {
    try {
      return path.normalize(uri.fsPath) === path.normalize(configFilePath());
    } catch {
      return false;
    }
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
      <div class="selectors">
        <select id="model" title="Model"></select>
        <select id="effort" title="Effort"></select>
      </div>
      <span id="cost" class="cost"></span>
      <button id="send" title="Send (Enter)">Send</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fmtCost(c: number): string {
  return "$" + (c < 0.01 ? c.toFixed(5) : c.toFixed(4));
}

function newId(): string {
  return crypto.randomUUID();
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
