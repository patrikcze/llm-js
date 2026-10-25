import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS, type ProviderKind } from "./providers.ts";

/**
 * Provider/model choice made in the UI, persisted between runs.
 * Lives outside the repository (default ~/.llm-agent/settings.json, mode 0600) so API keys
 * are never committed. Override the directory with AGENT_CONFIG_DIR.
 */
export interface SavedSettings {
  provider: ProviderKind;
  model: string;
  contextTokens?: number;
  providers: Partial<Record<ProviderKind, { baseURL?: string; apiKey?: string }>>;
}

export function settingsPath(): string {
  return path.join(process.env.AGENT_CONFIG_DIR || path.join(os.homedir(), ".llm-agent"), "settings.json");
}

export function loadSettings(): SavedSettings | null {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), "utf8")) as SavedSettings;
    if (!s || !PROVIDERS[s.provider] || typeof s.model !== "string") return null;
    s.providers ??= {};
    return s;
  } catch {
    return null;
  }
}

export function saveSettings(s: SavedSettings): void {
  const file = settingsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function keyHint(key: string | undefined): string | undefined {
  return key ? `••••${key.slice(-4)}` : undefined;
}

/** What the browser may see about each provider: never the key itself. */
export function publicProviders(saved: SavedSettings | null) {
  return (Object.keys(PROVIDERS) as ProviderKind[]).map((kind) => {
    const p = PROVIDERS[kind];
    const stored = saved?.providers[kind];
    const envKey = p.keyEnv ? process.env[p.keyEnv] : undefined;
    return {
      kind,
      label: p.label,
      description: p.description,
      baseURL: stored?.baseURL || p.defaultBaseURL,
      defaultBaseURL: p.defaultBaseURL,
      needsKey: p.needsKey,
      keyEnv: p.keyEnv,
      hasSavedKey: Boolean(stored?.apiKey),
      keyHint: keyHint(stored?.apiKey) ?? (envKey ? `${p.keyEnv} ${keyHint(envKey)}` : undefined),
      hasEnvKey: Boolean(envKey),
      defaultContextTokens: p.defaultContextTokens,
    };
  });
}
