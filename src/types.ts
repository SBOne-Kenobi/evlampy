// Shared types between the extension host and (where relevant) the webview.

export interface EvlampyConfig {
  /** Path (relative to workspace root, or absolute) to the user's system prompt file. Optional. */
  userSystemPromptPath?: string;
  /** OpenAI-compatible base URL. Defaults to OpenRouter. */
  baseURL: string;
  /** API key. Supports ${env:VAR} interpolation. */
  apiKey: string;
  /** Models offered in the model picker (OpenRouter slugs, e.g. "qwen/qwen3-max"). */
  models: string[];
  /** Which of `models` is selected by default. Falls back to models[0]. */
  defaultModel?: string;
  /** Passed straight through to OpenRouter (provider routing). */
  provider?: Record<string, unknown>;
  /** Passed straight through to OpenRouter (reasoning effort etc.). */
  reasoning?: Record<string, unknown>;
  /** Sampling temperature. */
  temperature?: number;
  /** Optional max_tokens. */
  maxTokens?: number;
}

/** An attachment chip in the chat: a whole file or a selected range of one. */
export interface Attachment {
  /** Workspace-relative path. */
  path: string;
  /** 1-based inclusive line range, if a selection. Absent => whole file. */
  range?: { startLine: number; endLine: number };
  /** The actual text content captured at attach time. */
  content: string;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD cost, if the provider reported it. */
  cost?: number;
}

/** A single search/replace hunk inside an `evlampy:edit` block. */
export interface Hunk {
  search: string;
  replace: string;
}

export type DiffOp =
  | { kind: "edit"; path: string; hunks: Hunk[] }
  | { kind: "new"; path: string; content: string }
  | { kind: "rewrite"; path: string; content: string }
  | { kind: "delete"; path: string };

// ---- Messages: webview <-> extension ----

export type ToWebview =
  | { type: "init"; models: string[]; defaultModel: string }
  | { type: "addAttachment"; attachment: Attachment }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; usage?: UsageInfo }
  | { type: "fileSuggestions"; query: string; items: string[] }
  | { type: "applyReport"; report: ApplyReport }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

export type FromWebview =
  | { type: "ready" }
  | {
      type: "send";
      text: string;
      attachments: Attachment[];
      model: string;
    }
  | { type: "requestFileSuggestions"; query: string }
  | { type: "acceptAll" }
  | { type: "rejectAll" }
  | { type: "openConfig" }
  | { type: "removeAttachment"; index: number };

export interface ApplyResultItem {
  path: string;
  ok: boolean;
  detail: string;
}

export interface ApplyReport {
  items: ApplyResultItem[];
  appliedCount: number;
  failedCount: number;
}
