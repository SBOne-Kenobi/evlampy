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
type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";
interface ApplyFailure {
  hunkIndex?: number;
  detail: string;
  search?: string;
  replace?: string;
}
interface ApplyResultItem {
  path: string;
  ok: boolean;
  detail: string;
  kind: "edit" | "new" | "rewrite" | "delete";
  opIndex: number;
  partial?: boolean;
  failures?: ApplyFailure[];
}
interface ApplyReport {
  items: ApplyResultItem[];
  appliedCount: number;
  failedCount: number;
}

interface DisplayTurn {
  role: "user" | "assistant";
  text: string;
}

type ToWebview =
  | { type: "init"; models: string[]; defaultModel: string }
  | { type: "addAttachment"; attachment: Attachment }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; usage?: UsageInfo }
  | { type: "fileSuggestions"; query: string; items: string[] }
  | { type: "applyReport"; report: ApplyReport }
  | { type: "clearChat" }
  | {
      type: "loadChat";
      turns: DisplayTurn[];
      totalCost: number;
      totalTokens: number;
    }
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
const composerEl = $("composer");
const inputEl = $<HTMLTextAreaElement>("input");
const modelEl = $<HTMLSelectElement>("model");
const effortEl = $<HTMLSelectElement>("effort");
const costEl = $("cost");
const sendBtn = $<HTMLButtonElement>("send");
const clearAttachmentsBtn = $<HTMLButtonElement>("clearAttachments");

let attachments: Attachment[] = [];
let streaming = false;
let currentAssistant: { el: HTMLElement; raw: string } | null = null;
let totalCost = 0;
let totalTokens = 0;
let availableModels: string[] = [];
let selectedModel = "";
let selectedEffort: EffortLevel = "high";
let transcript: DisplayTurn[] = [];
let lastAssistantEl: HTMLElement | null = null;

marked.setOptions({ gfm: true, breaks: false });

// ---- Persisted webview state (survives reload / hide) ----

interface SavedState {
  availableModels: string[];
  selectedModel: string;
  selectedEffort: EffortLevel;
  transcript: DisplayTurn[];
  totalCost: number;
  totalTokens: number;
}

function saveState() {
  vscode.setState({
    availableModels,
    selectedModel,
    selectedEffort,
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
  selectedEffort = s.selectedEffort ?? "high";
  transcript = s.transcript ?? [];
  totalCost = s.totalCost ?? 0;
  totalTokens = s.totalTokens ?? 0;
  populateModels();
  populateEfforts();
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

  if (availableModels.length === 0) {
    selectedModel = "";
    modelEl.disabled = true;
    return;
  }

  modelEl.disabled = false;
  if (!selectedModel || !availableModels.includes(selectedModel)) {
    selectedModel = availableModels[0];
  }
  modelEl.value = selectedModel;
}

function populateEfforts() {
  const efforts: EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];
  effortEl.innerHTML = "";
  efforts.forEach((effort) => {
    const o = document.createElement("option");
    o.value = effort;
    o.textContent = `effort: ${effort}`;
    effortEl.appendChild(o);
  });
  effortEl.value = selectedEffort;
}

modelEl.addEventListener("change", () => {
  selectedModel = modelEl.value;
  saveState();
});

effortEl.addEventListener("change", () => {
  selectedEffort = effortEl.value as EffortLevel;
  saveState();
});

// ---- Rendering ----

function addMessage(role: "user" | "assistant" | "system", text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  renderMessage(el, role, text);
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function renderMessage(
  el: HTMLElement,
  role: "user" | "assistant" | "system",
  text: string
) {
  if (role === "user") {
    el.textContent = text;
    return;
  }
  el.innerHTML = renderRichMessage(text);
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
      vscode.postMessage({ type: "removeAttachment", index: i });
      renderAttachments();
      inputEl.focus();
    };
    chip.appendChild(x);
    attachmentsEl.appendChild(chip);
  });
  updateAttachmentActions();
  if (suggestionsVisible()) {
    layoutSuggestions();
  }
}

function updateAttachmentActions() {
  clearAttachmentsBtn.hidden = attachments.length === 0;
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
    effort: selectedEffort,
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
clearAttachmentsBtn.onclick = () => {
  if (attachments.length === 0) {
    return;
  }
  attachments = [];
  vscode.postMessage({ type: "clearAttachments" });
  renderAttachments();
  inputEl.focus();
};

inputEl.addEventListener("keydown", (e) => {
  if (suggestionsVisible() && handleSuggestionKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener("input", onInputForMention);
window.addEventListener("resize", () => {
  if (suggestionsVisible()) {
    layoutSuggestions();
  }
});

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
  layoutSuggestions();
  suggestionsEl.classList.remove("hidden");
}

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
  suggestionItems = [];
}

function layoutSuggestions() {
  const inputRect = inputEl.getBoundingClientRect();
  const composerRect = composerEl.getBoundingClientRect();
  const bottomGap = Math.max(8, window.innerHeight - composerRect.top + 6);
  const maxHeight = Math.max(120, Math.min(320, composerRect.top - 16));

  suggestionsEl.style.position = "fixed";
  suggestionsEl.style.left = `${Math.round(inputRect.left)}px`;
  suggestionsEl.style.right = `${Math.max(8, Math.round(window.innerWidth - inputRect.right))}px`;
  suggestionsEl.style.bottom = `${Math.round(bottomGap)}px`;
  suggestionsEl.style.maxHeight = `${Math.round(maxHeight)}px`;
  suggestionsEl.style.zIndex = "1000";
  suggestionsEl.style.overflowY = "auto";
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
  const before = inputEl.value.slice(0, Math.max(0, mentionStart - 1));
  const after = inputEl.value.slice(pos);
  inputEl.value = before + after;
  const caret = before.length;
  inputEl.setSelectionRange(caret, caret);
  hideSuggestions();
  inputEl.focus();
  vscode.postMessage({ type: "attachByPath", path: pick });
}

// ---- Inbound messages ----

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "init": {
      availableModels = m.models;
      if (availableModels.length > 0) {
        if (!selectedModel || !availableModels.includes(selectedModel)) {
          selectedModel = m.defaultModel || availableModels[0];
        }
      } else {
        selectedModel = "";
      }
      populateModels();
      populateEfforts();
      saveState();
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
        renderMessage(currentAssistant.el, "assistant", currentAssistant.raw);
        scrollToBottom();
      }
      break;
    case "assistantDone":
      streaming = false;
      sendBtn.disabled = false;
      if (currentAssistant) {
        transcript.push({ role: "assistant", text: currentAssistant.raw });
        lastAssistantEl = currentAssistant.el;
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
      annotateAssistantReport(m.report, currentAssistant?.el ?? lastAssistantEl);
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
      addNotice("status", "Status", m.text);
      break;
    case "error":
      addNotice("error", "Error", m.message);
      streaming = false;
      sendBtn.disabled = false;
      break;
  }
});

function renderApplyReport(report: ApplyReport) {
  const issues = report.items.filter(
    (it) => !it.ok || it.partial || (it.failures?.length ?? 0) > 0
  );
  if (issues.length === 0) {
    return;
  }

  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `
    <div class="notice warning">
      <div class="notice-title">Manual review needed</div>
      <div class="notice-text">${issues.length} change block(s) were not fully applied.</div>
      ${issues
        .map(
          (it) => `
            <section class="report-item">
              <div class="report-path">${escapeHtml(it.path)}</div>
              <div class="report-detail">${escapeHtml(it.detail)}</div>
              ${renderFailureList(it.path, it.failures ?? [])}
            </section>
          `
        )
        .join("")}
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

/** Wipe the visible chat (keeps the model list/selection). */
function resetChat() {
  messagesEl.innerHTML = "";
  attachments = [];
  lastAssistantEl = null;
  renderAttachments();
  transcript = [];
  totalCost = 0;
  totalTokens = 0;
  currentAssistant = null;
  streaming = false;
  sendBtn.disabled = false;
  hideSuggestions();
  renderCost();
  saveState();
}

function renderRichMessage(text: string): string {
  const blockRegex =
    /<evlampy:(edit|new|rewrite|delete)\s+path="([^"]+)"\s*>([\s\S]*?)<\/evlampy:\1>/g;
  let html = "";
  let lastIndex = 0;
  let opIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    html += renderMarkdownBlock(text.slice(lastIndex, match.index));
    const [, kind, path, body] = match;
    html += renderSuggestionBlock(
      kind as "edit" | "new" | "rewrite" | "delete",
      path,
      body,
      opIndex
    );
    lastIndex = match.index + match[0].length;
    opIndex++;
  }

  html += renderMarkdownBlock(text.slice(lastIndex));
  return html;
}

function renderMarkdownBlock(text: string): string {
  const normalized = trimOuterBlankLines(text);
  if (!normalized.trim()) {
    return "";
  }
  return `<div class="md">${marked.parse(normalized) as string}</div>`;
}

function renderSuggestionBlock(
  kind: "edit" | "new" | "rewrite" | "delete",
  path: string,
  body: string,
  opIndex: number
): string {
  const suggestionText = formatSuggestionText(kind, path, body);
  return `
    <div class="suggestion" data-op-index="${opIndex}">
      ${marked.parse(buildFencedMarkdown(suggestionText)) as string}
    </div>
  `;
}

function annotateAssistantReport(report: ApplyReport, el: HTMLElement | null) {
  if (!el) {
    return;
  }

  report.items.forEach((item) => {
    const block = el.querySelector<HTMLElement>(`.suggestion[data-op-index="${item.opIndex}"]`);
    if (!block) {
      return;
    }

    block.classList.remove("failed", "partial");
    if (!item.ok) {
      block.classList.add("failed");
    } else if (item.partial || (item.failures?.length ?? 0) > 0) {
      block.classList.add("partial");
    }
    block.title = item.detail;
  });
}

function renderFailureList(path: string, failures: ApplyFailure[]): string {
  if (failures.length === 0) {
    return "";
  }

  return failures
    .map((failure) => {
      const detail =
        failure.hunkIndex !== undefined
          ? `Hunk ${failure.hunkIndex + 1}: ${failure.detail}`
          : failure.detail;
      const raw = buildFailureText(path, failure);

      return `
        <div class="failure-item">
          <div class="failure-detail">${escapeHtml(detail)}</div>
          ${raw
            ? `<div class="failed-suggestion">${marked.parse(buildFencedMarkdown(raw)) as string}</div>`
            : ""}
        </div>
      `;
    })
    .join("");
}

function addNotice(kind: "status" | "error", title: string, text: string) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = `
    <div class="notice ${kind}">
      <div class="notice-title">${escapeHtml(title)}</div>
      <div class="notice-text">${escapeHtml(text)}</div>
    </div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function formatSuggestionText(
  kind: "edit" | "new" | "rewrite" | "delete",
  path: string,
  body: string
): string {
  if (kind === "delete") {
    return `# ${path}\n\n(delete file)`;
  }

  const content = trimOuterBlankLines(body);
  return content ? `# ${path}\n\n${content}` : `# ${path}`;
}

function buildFailureText(path: string, failure: ApplyFailure): string {
  if (failure.search === undefined && failure.replace === undefined) {
    return "";
  }
  return `# ${path}

<<<<<<< SEARCH
${failure.search ?? ""}
=======
${failure.replace ?? ""}
>>>>>>> REPLACE`;
}

function buildFencedMarkdown(text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}
${text}
${fence}`;
}

function longestBacktickRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run++;
      if (run > best) {
        best = run;
      }
    } else {
      run = 0;
    }
  }
  return best;
}

function trimOuterBlankLines(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
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
populateEfforts();
restoreState();
vscode.postMessage({ type: "ready" });
