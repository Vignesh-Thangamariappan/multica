import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Dispatcher } from "undici";

import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  SsrfBlockedError,
} from "./ssrf.js";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./cache.js";
import type { CacheEntry } from "./cache.js";
import { extractContent, extractMarkdownTitle, markdownToText, truncateText, type ExtractMode, type ExtractorType } from "./html-utils.js";
import { jsonResult, readNumberParam, readStringParam } from "./param-helpers.js";

const EXTRACT_MODES = ["markdown", "text"] as const;
const EXTRACTOR_TYPES = ["readability", "turndown"] as const;

const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  extractMode: Type.Optional(
    Type.String({
      description: 'Output format: "markdown" (default) or "text" (plain text).',
    }),
  ),
  extractor: Type.Optional(
    Type.String({
      description:
        'Extraction method: "readability" (default, smart extraction of main content) or "turndown" (convert entire page).',
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded). Default: 50000.",
      minimum: 100,
    }),
  ),
});

type WebFetchArgs = {
  url: string;
  extractMode?: string;
  extractor?: string;
  maxChars?: number;
};

export type WebFetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  extractMode: ExtractMode;
  extractor: ExtractorType | "raw" | "json" | "markdown-native";
  truncated: boolean;
  length: number;
  fetchedAt: string;
  tookMs: number;
  text: string;
  cached?: boolean;
  markdownTokens?: number;
};

function resolveMaxChars(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(100, Math.floor(parsed));
}

function resolveMaxRedirects(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(parsed));
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed) return false;
  const head = trimmed.slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithRedirects(params: {
  url: string;
  maxRedirects: number;
  timeoutSeconds: number;
  userAgent: string;
}): Promise<{ response: Response; finalUrl: string; dispatcher: Dispatcher }> {
  const signal = withTimeout(undefined, params.timeoutSeconds * 1000);
  const visited = new Set<string>();
  let currentUrl = params.url;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid URL: must be http or https");
    }

    const pinned = await resolvePinnedHostname(parsedUrl.hostname);
    const dispatcher = createPinnedDispatcher(pinned);
    let res: Response;
    try {
      // Use undici's dispatcher for SSRF protection
      res = await fetch(parsedUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "text/markdown, text/html;q=0.9, */*;q=0.8",
          "User-Agent": params.userAgent,
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal,
        redirect: "manual",
        dispatcher,
      } as unknown as RequestInit);
    } catch (err) {
      await closeDispatcher(dispatcher);
      throw err;
    }

    if (isRedirectStatus(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        await closeDispatcher(dispatcher);
        throw new Error(`Redirect missing location header (${res.status})`);
      }
      redirectCount += 1;
      if (redirectCount > params.maxRedirects) {
        await closeDispatcher(dispatcher);
        throw new Error(`Too many redirects (limit: ${params.maxRedirects})`);
      }
      const nextUrl = new URL(location, parsedUrl).toString();
      if (visited.has(nextUrl)) {
        await closeDispatcher(dispatcher);
        throw new Error("Redirect loop detected");
      }
      visited.add(nextUrl);
      void res.body?.cancel();
      await closeDispatcher(dispatcher);
      currentUrl = nextUrl;
      continue;
    }

    return { response: res, finalUrl: currentUrl, dispatcher };
  }
}

function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType, maxChars } = params;
  if (!detail) return "";
  let text = detail;
  const contentTypeLower = contentType?.toLowerCase();
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    text = markdownToText(detail);
  }
  const truncated = truncateText(text.trim(), maxChars);
  return truncated.text;
}

async function runWebFetch(params: {
  url: string;
  extractMode: ExtractMode;
  extractor: ExtractorType;
  maxChars: number;
  maxRedirects: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
}): Promise<WebFetchResult> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.extractor}:${params.maxChars}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true } as WebFetchResult;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }

  const start = Date.now();
  let res: Response;
  let dispatcher: Dispatcher | null = null;
  let finalUrl = params.url;

  const result = await fetchWithRedirects({
    url: params.url,
    maxRedirects: params.maxRedirects,
    timeoutSeconds: params.timeoutSeconds,
    userAgent: params.userAgent,
  });
  res = result.response;
  finalUrl = result.finalUrl;
  dispatcher = result.dispatcher;

  try {
    if (!res.ok) {
      const rawDetail = await readResponseText(res);
      const detail = formatWebFetchErrorDetail({
        detail: rawDetail,
        contentType: res.headers.get("content-type"),
        maxChars: DEFAULT_ERROR_MAX_CHARS,
      });
      throw new Error(`Web fetch failed (${res.status}): ${detail || res.statusText}`);
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const body = await readResponseText(res);

    let title: string | undefined;
    let extractor: ExtractorType | "raw" | "json" | "markdown-native" = "raw";
    let text = body;
    let markdownTokens: number | undefined;

    // Capture x-markdown-tokens header when present (Cloudflare Markdown for Agents)
    const markdownTokensHeader = res.headers.get("x-markdown-tokens");
    if (markdownTokensHeader) {
      const parsed = Number.parseInt(markdownTokensHeader, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        markdownTokens = parsed;
      }
    }

    if (contentType.includes("text/markdown")) {
      // Server returned markdown directly (e.g. Cloudflare Markdown for Agents) — skip HTML parsing
      text = body;
      extractor = "markdown-native";
      title = extractMarkdownTitle(body);
      if (params.extractMode === "text") {
        text = markdownToText(body);
      }
    } else if (contentType.includes("text/html")) {
      const extracted = await extractContent({
        html: body,
        url: finalUrl,
        extractMode: params.extractMode,
        extractor: params.extractor,
      });
      text = extracted.text;
      title = extracted.title;
      extractor = extracted.extractor;
    } else if (contentType.includes("application/json")) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
        extractor = "json";
      } catch {
        text = body;
        extractor = "raw";
      }
    }

    const truncated = truncateText(text, params.maxChars);
    const payload: WebFetchResult = {
      url: params.url,
      finalUrl,
      status: res.status,
      contentType,
      extractMode: params.extractMode,
      extractor,
      truncated: truncated.truncated,
      length: truncated.text.length,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      text: truncated.text,
    };
    if (title) {
      payload.title = title;
    }
    if (markdownTokens !== undefined) {
      payload.markdownTokens = markdownTokens;
    }
    writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  } finally {
    await closeDispatcher(dispatcher);
  }
}

export function createWebFetchTool(): AgentTool<typeof WebFetchSchema, unknown> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      'Fetch and extract readable content from a URL. Converts HTML to markdown or plain text. Use extractor="readability" for smart article extraction, or "turndown" for full page conversion.',
    parameters: WebFetchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as WebFetchArgs;
      const url = readStringParam(params as Record<string, unknown>, "url", { required: true });
      const extractModeRaw = readStringParam(params as Record<string, unknown>, "extractMode");
      const extractMode: ExtractMode =
        extractModeRaw === "text" ? "text" : "markdown";
      const extractorRaw = readStringParam(params as Record<string, unknown>, "extractor");
      const extractor: ExtractorType =
        extractorRaw === "turndown" ? "turndown" : "readability";
      const maxChars = readNumberParam(params as Record<string, unknown>, "maxChars", { integer: true });

      try {
        const result = await runWebFetch({
          url,
          extractMode,
          extractor,
          maxChars: resolveMaxChars(maxChars, DEFAULT_FETCH_MAX_CHARS),
          maxRedirects: DEFAULT_FETCH_MAX_REDIRECTS,
          timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
          cacheTtlMs: resolveCacheTtlMs(DEFAULT_CACHE_TTL_MINUTES, DEFAULT_CACHE_TTL_MINUTES),
          userAgent: DEFAULT_FETCH_USER_AGENT,
        });
        return jsonResult(result);
      } catch (error) {
        if (error instanceof SsrfBlockedError) {
          return jsonResult({
            error: true,
            code: "ssrf_blocked",
            message: error.message,
          });
        }
        return jsonResult({
          error: true,
          code: "fetch_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
