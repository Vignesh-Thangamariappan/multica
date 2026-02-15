import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";
import { DATA_DIR } from "@multica/utils";

type ProviderConfig = {
  // API Key authentication
  apiKey?: string | undefined;
  // OAuth authentication
  oauthToken?: string | undefined;
  oauthRefreshToken?: string | undefined;
  oauthExpiresAt?: number | undefined;
  // Common
  baseUrl?: string | undefined;
  model?: string | undefined;
};

type ToolConfig = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
};

export type CredentialsConfig = {
  version?: number | undefined;
  llm?: {
    provider?: string | undefined;
    providers?: Record<string, ProviderConfig> | undefined;
    /** Explicit profile ordering per provider (e.g. { anthropic: ["anthropic", "anthropic:backup"] }) */
    order?: Record<string, string[]> | undefined;
  } | undefined;
  tools?: Record<string, ToolConfig> | undefined;
  /** Channel plugin configs (telegram, discord, etc.) */
  channels?: Record<string, Record<string, Record<string, unknown>> | undefined> | undefined;
};

const DEFAULT_CREDENTIALS_PATH = join(DATA_DIR, "credentials.json5");
const FALLBACK_CREDENTIALS_PATH = join(homedir(), ".super-multica", "credentials.json5");

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined ||
    process.env.VITEST_WORKER_ID !== undefined
  );
}

/**
 * Resolve the credentials file path.
 *
 * Lookup order:
 * 1. SMC_CREDENTIALS_PATH env var (explicit override)
 * 2. {DATA_DIR}/credentials.json5 (current data dir, respects SMC_DATA_DIR)
 * 3. ~/.super-multica/credentials.json5 (default location fallback —
 *    allows E2E tests and other custom SMC_DATA_DIR setups to
 *    share the production credentials)
 */
export function getCredentialsPath(): string {
  // Explicit env override — use as-is
  if (process.env.SMC_CREDENTIALS_PATH) {
    return expandHome(process.env.SMC_CREDENTIALS_PATH);
  }

  // Primary: current DATA_DIR
  if (existsSync(DEFAULT_CREDENTIALS_PATH)) {
    return DEFAULT_CREDENTIALS_PATH;
  }

  // Fallback: default ~/.super-multica location when using a custom data dir
  if (DEFAULT_CREDENTIALS_PATH !== FALLBACK_CREDENTIALS_PATH && existsSync(FALLBACK_CREDENTIALS_PATH)) {
    return FALLBACK_CREDENTIALS_PATH;
  }

  // Return primary path even if it doesn't exist (for error messages / creation)
  return DEFAULT_CREDENTIALS_PATH;
}

export class CredentialManager {
  private corePath: string | null = null;
  private disabledState: boolean | null = null;
  private coreConfig: CredentialsConfig | null = null;
  private coreMtimeMs: number | null = null;

  private isDisabled(): boolean {
    if (process.env.SMC_CREDENTIALS_DISABLE === "1") return true;
    return isTestEnv();
  }

  private loadCore(): void {
    const path = getCredentialsPath();
    const disabled = this.isDisabled();
    let mtimeMs: number | null = null;

    if (!disabled && existsSync(path)) {
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        mtimeMs = null;
      }
    }

    if (
      this.corePath === path
      && this.disabledState === disabled
      && this.coreConfig
      && this.coreMtimeMs === mtimeMs
    ) {
      return;
    }

    this.corePath = path;
    this.disabledState = disabled;
    this.coreConfig = null;
    this.coreMtimeMs = mtimeMs;

    if (disabled) return;
    if (mtimeMs === null) return;

    const raw = readFileSync(path, "utf8");
    try {
      this.coreConfig = JSON5.parse(raw) as CredentialsConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse credentials file (${path}): ${message}`);
    }
  }

  getLlmProvider(): string | undefined {
    this.loadCore();
    return this.coreConfig?.llm?.provider;
  }

  getLlmProviderConfig(provider: string): ProviderConfig | undefined {
    this.loadCore();
    return this.coreConfig?.llm?.providers?.[provider];
  }

  getToolConfig(toolName: string): ToolConfig | undefined {
    this.loadCore();
    return this.coreConfig?.tools?.[toolName];
  }

  /**
   * Get explicit profile order for a provider from credentials.json5 `llm.order`.
   * Returns undefined if no explicit order is configured.
   */
  getLlmOrder(provider: string): string[] | undefined {
    this.loadCore();
    return this.coreConfig?.llm?.order?.[provider];
  }

  /**
   * List all profile IDs from `llm.providers` that belong to a given provider.
   * A profile matches if its key equals the provider exactly or starts with "provider:".
   */
  listProfileIdsForProvider(provider: string): string[] {
    this.loadCore();
    const providers = this.coreConfig?.llm?.providers;
    if (!providers) return [];

    const prefix = `${provider}:`;
    return Object.keys(providers).filter(
      (key) => key === provider || key.startsWith(prefix),
    );
  }

  /** Get channel plugin configs from credentials.json5 `channels` section. */
  getChannelsConfig(): Record<string, Record<string, Record<string, unknown>> | undefined> {
    this.loadCore();
    return this.coreConfig?.channels ?? {};
  }

  reset(): void {
    this.corePath = null;
    this.disabledState = null;
    this.coreConfig = null;
    this.coreMtimeMs = null;
  }

  /**
   * Set the API key for a provider and save to credentials.json5.
   * Creates the file if it doesn't exist.
   */
  setLlmProviderApiKey(provider: string, apiKey: string): void {
    const path = getCredentialsPath();

    // Load existing config or create new one
    let config: CredentialsConfig = { version: 1 };
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        config = JSON5.parse(raw) as CredentialsConfig;
      } catch {
        // If parse fails, start fresh
        config = { version: 1 };
      }
    }

    // Ensure structure exists
    if (!config.llm) {
      config.llm = {};
    }
    if (!config.llm.providers) {
      config.llm.providers = {};
    }

    // Set or update the provider config
    const existing = config.llm.providers[provider] ?? {};
    config.llm.providers[provider] = {
      ...existing,
      apiKey,
    };

    // Write back to file
    mkdirSync(dirname(path), { recursive: true });
    const content = JSON.stringify(config, null, 2);
    writeFileSync(path, content, "utf8");

    // Reset cache so next read picks up the change
    this.reset();
  }

  /**
   * Set OAuth token for a provider and save to credentials.json5.
   * Used for OAuth providers like claude-code and openai-codex.
   */
  setLlmProviderOAuthToken(
    provider: string,
    token: string,
    refreshToken?: string,
    expiresAt?: number,
  ): void {
    const path = getCredentialsPath();

    // Load existing config or create new one
    let config: CredentialsConfig = { version: 1 };
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        config = JSON5.parse(raw) as CredentialsConfig;
      } catch {
        config = { version: 1 };
      }
    }

    // Ensure structure exists
    if (!config.llm) {
      config.llm = {};
    }
    if (!config.llm.providers) {
      config.llm.providers = {};
    }

    // Set or update the provider config
    const existing = config.llm.providers[provider] ?? {};
    config.llm.providers[provider] = {
      ...existing,
      oauthToken: token,
      oauthRefreshToken: refreshToken,
      oauthExpiresAt: expiresAt,
    };

    // Write back to file
    mkdirSync(dirname(path), { recursive: true });
    const content = JSON.stringify(config, null, 2);
    writeFileSync(path, content, "utf8");

    // Reset cache
    this.reset();
  }

  /**
   * Set a channel account config and save to credentials.json5.
   * Creates the channels section if it doesn't exist.
   * Used by the desktop Channels page to persist bot tokens.
   */
  setChannelAccountConfig(channelId: string, accountId: string, accountConfig: Record<string, unknown>): void {
    const path = getCredentialsPath();

    let config: CredentialsConfig = { version: 1 };
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        config = JSON5.parse(raw) as CredentialsConfig;
      } catch {
        config = { version: 1 };
      }
    }

    // Ensure channels.[channelId] structure exists
    if (!config.channels) {
      config.channels = {};
    }
    if (!config.channels[channelId]) {
      config.channels[channelId] = {};
    }

    // Set or update the account config
    config.channels[channelId]![accountId] = accountConfig;

    mkdirSync(dirname(path), { recursive: true });
    const content = JSON.stringify(config, null, 2);
    writeFileSync(path, content, "utf8");

    this.reset();
  }

  /**
   * Remove a channel account config from credentials.json5.
   * Cleans up the parent channel section if no accounts remain.
   */
  removeChannelAccountConfig(channelId: string, accountId: string): void {
    const path = getCredentialsPath();
    if (!existsSync(path)) return;

    let config: CredentialsConfig;
    try {
      const raw = readFileSync(path, "utf8");
      config = JSON5.parse(raw) as CredentialsConfig;
    } catch {
      return;
    }

    const channelSection = config.channels?.[channelId];
    if (!channelSection) return;

    delete channelSection[accountId];

    // Clean up empty channel section
    if (Object.keys(channelSection).length === 0) {
      delete config.channels![channelId];
    }

    mkdirSync(dirname(path), { recursive: true });
    const content = JSON.stringify(config, null, 2);
    writeFileSync(path, content, "utf8");

    this.reset();
  }

  /**
   * Set the default LLM provider and save to credentials.json5.
   */
  setDefaultLlmProvider(provider: string): void {
    const path = getCredentialsPath();

    // Load existing config or create new one
    let config: CredentialsConfig = { version: 1 };
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        config = JSON5.parse(raw) as CredentialsConfig;
      } catch {
        config = { version: 1 };
      }
    }

    // Ensure structure exists
    if (!config.llm) {
      config.llm = {};
    }

    // Set default provider
    config.llm.provider = provider;

    // Write back to file
    mkdirSync(dirname(path), { recursive: true });
    const content = JSON.stringify(config, null, 2);
    writeFileSync(path, content, "utf8");

    // Reset cache
    this.reset();
  }
}

export const credentialManager = new CredentialManager();
