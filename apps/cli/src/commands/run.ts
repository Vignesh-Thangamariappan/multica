/**
 * Run command - Execute a single prompt non-interactively
 *
 * Usage:
 *   multica run [options] <prompt>
 *   echo "prompt" | multica run
 */

import { join } from "node:path";
import { Agent, Hub, listSubagentRuns } from "@multica/core";
import type { AgentOptions } from "@multica/core";
import type { ToolsConfig } from "@multica/core";
import { DATA_DIR } from "@multica/utils";
import { cyan, yellow, dim } from "../colors.js";

type RunOptions = {
  profile?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  system?: string | undefined;
  thinking?: string | undefined;
  reasoning?: string | undefined;
  cwd?: string | undefined;
  session?: string | undefined;
  debug?: boolean;
  runLog?: boolean;
  toolsAllow?: string[];
  toolsDeny?: string[];
  help?: boolean;
};

function printHelp() {
  console.log(`
${cyan("Usage:")} multica run [options] <prompt>
       echo "prompt" | multica run

${cyan("Options:")}
  ${yellow("--profile")} ID        Load agent profile
  ${yellow("--provider")} NAME     LLM provider (openai, anthropic, kimi, etc.)
  ${yellow("--model")} NAME        Model name
  ${yellow("--api-key")} KEY       API key (overrides environment)
  ${yellow("--base-url")} URL      Custom base URL for provider
  ${yellow("--system")} TEXT       System prompt (ignored if --profile set)
  ${yellow("--thinking")} LEVEL    Thinking level
  ${yellow("--reasoning")} MODE   Reasoning display mode (off, on, stream)
  ${yellow("--cwd")} DIR           Working directory
  ${yellow("--session")} ID        Session ID for persistence
  ${yellow("--debug")}             Enable debug logging
  ${yellow("--run-log")}           Enable structured run logging (run-log.jsonl)
  ${yellow("--help")}, -h          Show this help

${cyan("Tools Configuration:")}
  ${yellow("--tools-allow")} T     Allow specific tools (comma-separated)
  ${yellow("--tools-deny")} T      Deny specific tools (comma-separated)

${cyan("Examples:")}
  ${dim("# Run with default settings")}
  multica run "What is 2+2?"

  ${dim("# Use a specific profile")}
  multica run --profile coder "List files in this directory"

  ${dim("# Pipe input")}
  echo "Explain this code" | multica run

  ${dim("# Resume a session")}
  multica run --session abc123 "Continue from where we left off"
`);
}

function parseArgs(argv: string[]): { opts: RunOptions; prompt: string } {
  const args = [...argv];
  const opts: RunOptions = {};
  const promptParts: string[] = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      break;
    }
    if (arg === "--profile") {
      opts.profile = args.shift();
      continue;
    }
    if (arg === "--provider") {
      opts.provider = args.shift();
      continue;
    }
    if (arg === "--model") {
      opts.model = args.shift();
      continue;
    }
    if (arg === "--api-key") {
      opts.apiKey = args.shift();
      continue;
    }
    if (arg === "--base-url") {
      opts.baseUrl = args.shift();
      continue;
    }
    if (arg === "--system") {
      opts.system = args.shift();
      continue;
    }
    if (arg === "--thinking") {
      opts.thinking = args.shift();
      continue;
    }
    if (arg === "--reasoning") {
      opts.reasoning = args.shift();
      continue;
    }
    if (arg === "--cwd") {
      opts.cwd = args.shift();
      continue;
    }
    if (arg === "--session") {
      opts.session = args.shift();
      continue;
    }
    if (arg === "--debug") {
      opts.debug = true;
      continue;
    }
    if (arg === "--run-log") {
      opts.runLog = true;
      continue;
    }
    if (arg === "--tools-allow") {
      const value = args.shift();
      opts.toolsAllow = value?.split(",").map((s) => s.trim()) ?? [];
      continue;
    }
    if (arg === "--tools-deny") {
      const value = args.shift();
      opts.toolsDeny = value?.split(",").map((s) => s.trim()) ?? [];
      continue;
    }
    if (arg === "--") {
      promptParts.push(...args);
      break;
    }
    promptParts.push(arg);
  }

  return { opts, prompt: promptParts.join(" ") };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

export async function runCommand(args: string[]): Promise<void> {
  const { opts, prompt } = parseArgs(args);

  if (opts.help) {
    printHelp();
    return;
  }

  const stdinPrompt = await readStdin();
  const finalPrompt = prompt || stdinPrompt;

  if (!finalPrompt) {
    printHelp();
    process.exit(1);
  }

  // Build tools config if any tools options are set
  let toolsConfig: ToolsConfig | undefined;
  if (opts.toolsAllow || opts.toolsDeny) {
    toolsConfig = {};
    if (opts.toolsAllow) {
      toolsConfig.allow = opts.toolsAllow;
    }
    if (opts.toolsDeny) {
      toolsConfig.deny = opts.toolsDeny;
    }
  }

  const enableRunLog = opts.runLog || !!process.env.MULTICA_RUN_LOG;

  // Initialize Hub to enable full agent capabilities (sub-agents, channels, cron).
  // Matches Desktop environment where Hub is always active.
  // Gateway connection failures are non-blocking (auto-reconnect with backoff).
  const gatewayUrl = process.env.GATEWAY_URL || "http://localhost:3000";
  const hub = new Hub(gatewayUrl);

  try {
    const agent = new Agent({
      profileId: opts.profile,
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      systemPrompt: opts.system,
      thinkingLevel: opts.thinking as any,
      reasoningMode: opts.reasoning as AgentOptions["reasoningMode"],
      cwd: opts.cwd,
      sessionId: opts.session,
      debug: opts.debug,
      enableRunLog,
      tools: toolsConfig,
    });

    const sessionDir = join(DATA_DIR, "sessions", agent.sessionId);

    // If it's a newly created session, notify user of sessionId
    if (!opts.session) {
      console.error(`[session: ${agent.sessionId}]`);
    }
    if (enableRunLog) {
      console.error(`[session-dir: ${sessionDir}]`);
    }

    const result = await agent.run(finalPrompt);
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exitCode = 1;
    }

    // Wait for sub-agents to complete and parent to process their results.
    // Without this, CLI exits before sub-agent announcements are delivered.
    await waitForSubagents(agent);
  } finally {
    hub.shutdown();
  }
}

/**
 * Wait for any running sub-agents to complete, then output their findings.
 *
 * In CLI mode, the parent Agent is not registered with the Hub, so the normal
 * announce flow (Hub → writeInternal) can't deliver results. Instead, we poll
 * the registry and print findings directly once all sub-agents finish.
 *
 * Max wait: 30 minutes (matches default sub-agent timeout).
 */
async function waitForSubagents(agent: Agent): Promise<void> {
  const MAX_WAIT_MS = 30 * 60 * 1000;
  const POLL_INTERVAL_MS = 2000;
  const start = Date.now();

  const allRuns = listSubagentRuns(agent.sessionId);
  if (allRuns.length === 0) return;

  // Phase 1: Wait for all sub-agent runs to finish
  while (Date.now() - start < MAX_WAIT_MS) {
    const runs = listSubagentRuns(agent.sessionId);
    const running = runs.filter((r) => !r.endedAt);
    if (running.length === 0) break;
    console.error(dim(`[waiting for ${running.length} sub-agent(s)...]`));
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Phase 2: Output sub-agent findings directly (bypasses Hub announce flow)
  const completedRuns = listSubagentRuns(agent.sessionId).filter((r) => r.endedAt);
  if (completedRuns.length === 0) return;

  console.error(dim(`[${completedRuns.length} sub-agent(s) completed]`));

  for (const run of completedRuns) {
    const displayName = run.label || run.task.slice(0, 60);
    const status = run.outcome?.status ?? "unknown";
    const findings = run.findings || "(no output)";
    console.log(`\n--- Sub-agent: ${displayName} [${status}] ---`);
    console.log(findings);
  }
}
