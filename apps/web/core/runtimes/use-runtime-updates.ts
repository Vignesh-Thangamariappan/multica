import { useQuery } from "@tanstack/react-query";
import { runtimeListOptions } from "./queries";
import type { AgentRuntime } from "@/shared/types";

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/multica-ai/multica/releases/latest";

export const latestVersionKeys = {
  latest: ["github", "latest-version"] as const,
};

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(GITHUB_RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

function stripV(v: string): string {
  return v.replace(/^v/, "");
}

function isNewer(latest: string, current: string): boolean {
  const l = stripV(latest).split(".").map(Number);
  const c = stripV(current).split(".").map(Number);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

function getCliVersion(runtime: AgentRuntime): string | null {
  const v = runtime.metadata?.cli_version;
  return typeof v === "string" && v ? v : null;
}

/**
 * Returns the count of local runtimes that have an available update.
 * Uses TanStack Query for caching (10 min stale time for GitHub check).
 */
export function useRuntimeUpdateCount(wsId: string | undefined) {
  const { data: latestVersion } = useQuery({
    queryKey: latestVersionKeys.latest,
    queryFn: fetchLatestVersion,
    staleTime: 10 * 60 * 1000, // 10 minutes
    enabled: !!wsId,
  });

  const { data: runtimes } = useQuery({
    ...runtimeListOptions(wsId!),
    enabled: !!wsId,
  });

  if (!latestVersion || !runtimes) return 0;

  return runtimes.filter((r) => {
    if (r.runtime_mode !== "local") return false;
    const cv = getCliVersion(r);
    return cv ? isNewer(latestVersion, cv) : false;
  }).length;
}

/**
 * Returns a Set of runtime IDs that have an available update.
 */
export function useRuntimesWithUpdates(wsId: string | undefined) {
  const { data: latestVersion } = useQuery({
    queryKey: latestVersionKeys.latest,
    queryFn: fetchLatestVersion,
    staleTime: 10 * 60 * 1000,
    enabled: !!wsId,
  });

  const { data: runtimes } = useQuery({
    ...runtimeListOptions(wsId!),
    enabled: !!wsId,
  });

  if (!latestVersion || !runtimes) return new Set<string>();

  const ids = new Set<string>();
  for (const r of runtimes) {
    if (r.runtime_mode !== "local") continue;
    const cv = getCliVersion(r);
    if (cv && isNewer(latestVersion, cv)) {
      ids.add(r.id);
    }
  }
  return ids;
}
