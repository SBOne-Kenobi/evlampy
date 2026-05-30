import OpenAI from "openai";
import { EvlampyConfig, UsageInfo } from "./types";

export interface ChatRequest {
  config: EvlampyConfig;
  model: string;
  system: string;
  user: string;
  /** Called with each streamed text delta. */
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  usage?: UsageInfo;
}

/**
 * One single streaming request to an OpenAI-compatible endpoint (OpenRouter).
 * Provider/reasoning/usage are passed straight through — we invent no format.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const client = new OpenAI({
    baseURL: req.config.baseURL,
    apiKey: req.config.apiKey,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/SBOne-Kenobi/evlampy",
      "X-Title": "Evlampy",
    },
  });

  // Build the body. Extra OpenRouter fields aren't in the SDK type, so cast.
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    stream: true,
    stream_options: { include_usage: true },
    // Ask OpenRouter to include credit cost in usage.
    usage: { include: true },
  };
  if (req.config.temperature !== undefined) {
    body.temperature = req.config.temperature;
  }
  if (req.config.maxTokens !== undefined) {
    body.max_tokens = req.config.maxTokens;
  }
  if (req.config.provider && Object.keys(req.config.provider).length > 0) {
    body.provider = req.config.provider;
  }
  if (req.config.reasoning && Object.keys(req.config.reasoning).length > 0) {
    body.reasoning = req.config.reasoning;
  }

  const stream = await client.chat.completions.create(body as any, {
    signal: req.signal,
  });

  let text = "";
  let usage: UsageInfo | undefined;

  for await (const chunk of stream as any) {
    const delta: string | undefined = chunk?.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      req.onDelta(delta);
    }
    if (chunk?.usage) {
      usage = toUsage(chunk.usage);
    }
  }

  return { text, usage };
}

function toUsage(u: any): UsageInfo {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    cost: typeof u.cost === "number" ? u.cost : undefined,
  };
}
