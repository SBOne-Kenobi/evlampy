import * as vscode from "vscode";
import * as path from "path";
import { EvlampyConfig } from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class ConfigError extends Error {}

/** Resolve ${env:VAR} references inside a string. */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
    return process.env[name] ?? "";
  });
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Absolute path to the config file, honoring the evlampy.configPath setting. */
export function configFilePath(): string {
  const setting =
    vscode.workspace.getConfiguration("evlampy").get<string>("configPath") ||
    ".evlampy/config.json";
  if (path.isAbsolute(setting)) {
    return setting;
  }
  const root = workspaceRoot();
  if (!root) {
    throw new ConfigError("No workspace folder is open.");
  }
  return path.join(root, setting);
}

/** Read + validate the config. Throws ConfigError with a friendly message. */
export async function loadConfig(): Promise<EvlampyConfig> {
  const file = configFilePath();
  const uri = vscode.Uri.file(file);

  let raw: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    raw = Buffer.from(bytes).toString("utf8");
  } catch {
    throw new ConfigError(
      `Config not found at ${file}. Run "Evlampy: Open Config" to create one.`
    );
  }

  let parsed: Partial<EvlampyConfig>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config is not valid JSON: ${(e as Error).message}`);
  }

  const apiKey = interpolateEnv(parsed.apiKey ?? "").trim();
  if (!apiKey) {
    throw new ConfigError(
      'Config is missing "apiKey" (or the referenced env var is empty).'
    );
  }
  const models = parsed.models ?? [];
  if (!Array.isArray(models) || models.length === 0) {
    throw new ConfigError('Config must list at least one model in "models".');
  }

  return {
    userSystemPromptPath: parsed.userSystemPromptPath,
    baseURL: parsed.baseURL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    models,
    defaultModel:
      parsed.defaultModel && models.includes(parsed.defaultModel)
        ? parsed.defaultModel
        : models[0],
    provider: parsed.provider,
    reasoning: parsed.reasoning,
    temperature: parsed.temperature,
    maxTokens: parsed.maxTokens,
  };
}

/** Read the user system prompt file, or "" if none/unreadable. */
export async function loadUserSystemPrompt(
  cfg: EvlampyConfig
): Promise<string> {
  if (!cfg.userSystemPromptPath) {
    return "";
  }
  let file = cfg.userSystemPromptPath;
  if (!path.isAbsolute(file)) {
    const root = workspaceRoot();
    if (!root) {
      return "";
    }
    file = path.join(root, file);
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    return Buffer.from(bytes).toString("utf8").trim();
  } catch {
    return "";
  }
}

const SAMPLE_CONFIG = `{
  "userSystemPromptPath": ".evlampy/system.md",
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKey": "\${env:OPENROUTER_API_KEY}",
  "models": ["qwen/qwen3-max", "deepseek/deepseek-chat"],
  "defaultModel": "qwen/qwen3-max",
  "provider": {},
  "reasoning": { "effort": "high" },
  "temperature": 0.3
}
`;

const SAMPLE_SYSTEM = `# Your project rules go here.
# This text is appended after Evlampy's minimal format prompt.
`;

/** Create a starter config + system prompt if they don't exist, then open the config. */
export async function ensureConfigScaffold(): Promise<void> {
  const file = configFilePath();
  const uri = vscode.Uri.file(file);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(SAMPLE_CONFIG, "utf8"));
    const sysUri = vscode.Uri.file(path.join(path.dirname(file), "system.md"));
    try {
      await vscode.workspace.fs.stat(sysUri);
    } catch {
      await vscode.workspace.fs.writeFile(
        sysUri,
        Buffer.from(SAMPLE_SYSTEM, "utf8")
      );
    }
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}
