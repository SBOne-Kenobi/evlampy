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

type ToWebview =
  | { type: "init"; models: string[]; defaultModel: string }
  | { type: "addAttachment"; attachment: Attachment }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; usage?: UsageInfo }
  | { type: "fileSuggestions"; query: string; items: string[] }
  | { type: "applyReport"; report: ApplyReport }
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
const diffbar = $("diffbar");
const diffsummary = $("diffsummary");
const acceptBtn = $<HTMLButtonElement>("accept");
const rejectBtn = $<HTMLButtonElement>("reject");

let attachments: Attachment[] = [];
let streaming = false;
let currentAssistant: { el: HTMLElement; raw: string } | null = null;
let totalCost = 0;
let totalTokens = 0;

marked.setOptions({ gfm: true, breaks: false });

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

function setCost(usage?: UsageInfo) {
  if (usage) {
    totalTokens += usage.totalTokens;
    if (usage.cost) totalCost += usage.cost;
  }
  const last = usage
    ? `last: ${fmtCost(usage.cost)} · ${usage.totalTokens} tok`
    : "";
  const total = `total: ${fmtCost(totalCost)} · ${totalTokens} tok`;
  costEl.textContent = usage ? `${last}  |  ${total}` : total;
}

function fmtCost(c?: number): string {
  if (c === undefined) return "$—";
  return "$" + c.toFixed(c < 0.01 ? 5 : 4);
}

// ---- Sending ----

function send() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  addMessage("user", attachmentsLabel() + text);
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

acceptBtn.onclick = () => vscode.postMessage({ type: "acceptAll" });
rejectBtn.onclick = () => vscode.postMessage({ type: "rejectAll" });

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
  const pos = inputEl.selectionStart ?? 0;
  const before = inputEl.value.slice(0, mentionStart);
  const after = inputEl.value.slice(pos);
  inputEl.value = before + pick + " " + after;
  const caret = (before + pick + " ").length;
  inputEl.setSelectionRange(caret, caret);
  hideSuggestions();
  inputEl.focus();
}

// ---- Inbound messages ----

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      modelEl.innerHTML = "";
      m.models.forEach((mod) => {
        const o = document.createElement("option");
        o.value = mod;
        o.textContent = mod;
        modelEl.appendChild(o);
      });
      if (m.defaultModel) modelEl.value = m.defaultModel;
      setCost();
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
      currentAssistant = null;
      setCost(m.usage);
      break;
    case "fileSuggestions":
      showSuggestions(m.items);
      break;
    case "applyReport":
      renderApplyReport(m.report);
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
  const lines = report.items
    .map((it) => `${it.ok ? "✅" : "⚠️"} \`${it.path}\` — ${it.detail}`)
    .join("\n");
  addMessage(
    "system",
    `**Applied ${report.appliedCount}, failed ${report.failedCount}**\n\n${lines}`
  );
  if (report.appliedCount > 0) {
    diffbar.classList.remove("hidden");
    diffsummary.textContent = `${report.appliedCount} file(s) changed — review in the diff editors.`;
  }
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

// Hide the diff bar once a new request starts.
inputEl.addEventListener("focus", () => {});

vscode.postMessage({ type: "ready" });
