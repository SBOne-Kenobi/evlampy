import { marked } from "marked";

// ---- Types mirrored from src/types.ts (kept local to avoid bundling vscode) ----
interface Attachment {
  path: string;
  range?: { startLine: number; endLine: number };
  content: string;
}
interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
}
interface ApplyResultItem { path: string; ok: boolean; detail: string; }
interface ApplyReport { items: ApplyResultItem[]; appliedCount: number; failedCount: number; }

interface DisplayTurn { role: "user" | "assistant"; text: string; }

type ToWebview =
  | { type: "init"; models: string[]; defaultModel: string }
  | { type: "addAttachment"; attachment: Attachment }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; usage?: UsageInfo }
  | { type: "fileSuggestions"; query: string; items: string[] }
  | { type: "applyReport"; report: ApplyReport }
  | { type: "clearChat" }
  | { type: "loadChat"; turns: DisplayTurn[]; totalCost: number; totalTokens: number }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
};

const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const messagesEl = $("messages");
const attachmentsEl = $("attachments");
const suggestionsEl = $("suggestions");
const inputEl = $<HTMLTextAreaElement>("input");
const modelEl = $<HTMLSelectElement>("model");
const costEl = $("cost");
const sendBtn = $<HTMLButtonElement>("send");

let attachments: Attachment[] = [];
let streaming = false;
let currentAssistant: { el: HTMLElement; raw: string } | null = null;
let totalCost = 0;
let totalTokens = 0;
let availableModels: string[] = [];
let selectedModel = "";
let transcript: DisplayTurn[] = [];

marked.setOptions({ gfm: true, breaks: false });

// ---- Persisted webview state (survives reload / hide) ----

interface SavedState {
  availableModels: string[];
  selectedModel: string;
  transcript: DisplayTurn[];
  totalCost: number;
  totalTokens: number;
}

function saveState() {
  vscode.setState({
    availableModels,
    selectedModel,
    transcript,
    totalCost,
    totalTokens,
  } satisfies SavedState);
}

function restoreState() {
  const s = vscode.getState() as SavedState | undefined;
  if (!s) {
    return;
  }
  availableModels = s.availableModels ?? [];
  selectedModel = s.selectedModel ?? "";
  transcript = s.transcript ?? [];
  totalCost = s.totalCost ?? 0;
  totalTokens = s.totalTokens ?? 0;
  populateModels();
  transcript.forEach((t) => addMessage(t.role, t.text));
  renderCost();
}

function populateModels() {
  modelEl.innerHTML = "";
  availableModels.forEach((mod) => {
    const o = document.createElement("option");
    o.value = mod;
    o.textContent = mod;
    modelEl.appendChild(o);
  });
  if (selectedModel && availableModels.includes(selectedModel)) {
    modelEl.value = selectedModel;
  }
}

modelEl.addEventListener("change", () => {
  selectedModel = modelEl.value;
  saveState();
});

// ---- Rendering ----

function addMessage(role: "user" | "assistant" | "system", text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "user") {
    el.textContent = text;
  } else {
    el.innerHTML = marked.parse(text) as string;
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = a.range
      ? `${a.path}:${a.range.startLine}-${a.range.endLine}`
      : a.path;
    chip.title = label;
    chip.textContent = label;
    const x = document.createElement("button");
    x.className = "chipx";
    x.textContent = "×";
    x.onclick = () => {
      attachments.splice(i, 1);
      renderAttachments();
    };
    chip.appendChild(x);
    attachmentsEl.appendChild(chip);
  });
}

function renderCost(lastUsage?: UsageInfo) {
  const last = lastUsage
    ? `last: ${fmtCost(lastUsage.cost)} · ${lastUsage.totalTokens} tok`
    : "";
  const total = `total: ${fmtCost(totalCost)} · ${totalTokens} tok`;
  costEl.textContent = lastUsage ? `${last}  |  ${total}` : total;
}

function fmtCost(c?: number): string {
  if (c === undefined) return "$—";
  return "$" + c.toFixed(c < 0.01 ? 5 : 4);
}

// ---- Sending ----

function send() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  const display = attachmentsLabel() + text;
  addMessage("user", display);
  transcript.push({ role: "user", text: display });
  saveState();
  vscode.postMessage({
    type: "send",
    text,
    attachments,
    model: modelEl.value,
  });
  inputEl.value = "";
  attachments = [];
  renderAttachments();
}

function attachmentsLabel(): string {
  if (attachments.length === 0) return "";
  return (
    attachments
      .map((a) =>
        a.range ? `@${a.path}:${a.range.startLine}-${a.range.endLine}` : `@${a.path}`
      )
      .join("  ") + "\n\n"
  );
}

sendBtn.onclick = send;

inputEl.addEventListener("keydown", (e) => {
  if (suggestionsVisible() && handleSuggestionKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener("input", onInputForMention);

// ---- @ mention autocomplete ----

let suggestionItems: string[] = [];
let suggestionIndex = 0;
let mentionStart = -1;

function onInputForMention() {
  const pos = inputEl.selectionStart ?? 0;
  const upto = inputEl.value.slice(0, pos);
  const m = /(^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) {
    hideSuggestions();
    return;
  }
  mentionStart = pos - m[2].length;
  vscode.postMessage({ type: "requestFileSuggestions", query: m[2] });
}

function showSuggestions(items: string[]) {
  suggestionItems = items;
  suggestionIndex = 0;
  if (items.length === 0) {
    hideSuggestions();
    return;
  }
  suggestionsEl.innerHTML = "";
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "sugg" + (i === 0 ? " active" : "");
    row.textContent = it;
    row.onclick = () => pickSuggestion(i);
    suggestionsEl.appendChild(row);
  });
  suggestionsEl.classList.remove("hidden");
}

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
  suggestionItems = [];
}

function suggestionsVisible(): boolean {
  return !suggestionsEl.classList.contains("hidden");
}

function handleSuggestionKey(e: KeyboardEvent): boolean {
  if (e.key === "ArrowDown") {
    suggestionIndex = (suggestionIndex + 1) % suggestionItems.length;
    refreshActive();
    e.preventDefault();
    return true;
  }
  if (e.key === "ArrowUp") {
    suggestionIndex =
      (suggestionIndex - 1 + suggestionItems.length) % suggestionItems.length;
    refreshActive();
    e.preventDefault();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    pickSuggestion(suggestionIndex);
    e.preventDefault();
    return true;
  }
  if (e.key === "Escape") {
    hideSuggestions();
    e.preventDefault();
    return true;
  }
  return false;
}

function refreshActive() {
  Array.from(suggestionsEl.children).forEach((c, i) =>
    c.classList.toggle("active", i === suggestionIndex)
  );
}

function pickSuggestion(i: number) {
  const pick = suggestionItems[i];
  if (!pick || mentionStart < 0) {
    hideSuggestions();
    return;
  }
  // Drop the typed "@partial" (the "@" sits just before mentionStart) ...
  const pos = inputEl.selectionStart ?? 0;
  const before = inputEl.value.slice(0, Math.max(0, mentionStart - 1));
  const after = inputEl.value.slice(pos);
  inputEl.value = before + after;
  const caret = before.length;
  inputEl.setSelectionRange(caret, caret);
  hideSuggestions();
  inputEl.focus();
  // ... and attach the actual file content as a chip.
  vscode.postMessage({ type: "attachByPath", path: pick });
}

// ---- Inbound messages ----

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      // Don't wipe a working dropdown if a re-init arrives with no models.
      if (m.models.length > 0) {
        availableModels = m.models;
        if (!selectedModel || !availableModels.includes(selectedModel)) {
          selectedModel = m.defaultModel || availableModels[0];
        }
        populateModels();
        saveState();
      }
      renderCost();
      break;
    }
    case "addAttachment":
      if (!attachments.some((a) => sameAttachment(a, m.attachment))) {
        attachments.push(m.attachment);
        renderAttachments();
      }
      inputEl.focus();
      break;
    case "assistantStart":
      streaming = true;
      sendBtn.disabled = true;
      currentAssistant = { el: addMessage("assistant", ""), raw: "" };
      break;
    case "assistantDelta":
      if (currentAssistant) {
        currentAssistant.raw += m.text;
        currentAssistant.el.innerHTML = marked.parse(currentAssistant.raw) as string;
        scrollToBottom();
      }
      break;
    case "assistantDone":
      streaming = false;
      sendBtn.disabled = false;
      if (currentAssistant) {
        transcript.push({ role: "assistant", text: currentAssistant.raw });
      }
      currentAssistant = null;
      if (m.usage) {
        totalTokens += m.usage.totalTokens;
        if (m.usage.cost) totalCost += m.usage.cost;
      }
      renderCost(m.usage);
      saveState();
      break;
    case "fileSuggestions":
      showSuggestions(m.items);
      break;
    case "applyReport":
      renderApplyReport(m.report);
      break;
    case "clearChat":
      resetChat();
      break;
    case "loadChat":
      resetChat();
      transcript = m.turns.map((t) => ({ role: t.role, text: t.text }));
      transcript.forEach((t) => addMessage(t.role, t.text));
      totalCost = m.totalCost;
      totalTokens = m.totalTokens;
      renderCost();
      saveState();
      break;
    case "status":
      addMessage("system", `_${m.text}_`);
      break;
    case "error":
      addMessage("system", `**Error:** ${escapeHtml(m.message)}`);
      streaming = false;
      sendBtn.disabled = false;
      break;
  }
});

function renderApplyReport(report: ApplyReport) {
  // Only surface problems here; successful files live in the review list.
  const failed = report.items.filter((it) => !it.ok);
  if (failed.length === 0) {
    return;
  }
  const lines = failed
    .map((it) => `⚠️ \`${it.path}\` — ${it.detail}`)
    .join("\n");
  addMessage("system", `**${failed.length} change(s) not applied**\n\n${lines}`);
}

/** Wipe the visible chat (keeps the model list/selection). */
function resetChat() {
  messagesEl.innerHTML = "";
  attachments = [];
  renderAttachments();
  transcript = [];
  totalCost = 0;
  totalTokens = 0;
  currentAssistant = null;
  streaming = false;
  sendBtn.disabled = false;
  renderCost();
  saveState();
}

function sameAttachment(a: Attachment, b: Attachment): boolean {
  return (
    a.path === b.path &&
    a.range?.startLine === b.range?.startLine &&
    a.range?.endLine === b.range?.endLine
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

// Restore any persisted view state, then ask the extension for fresh config.
restoreState();
vscode.postMessage({ type: "ready" });
