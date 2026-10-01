package execenv

import (
	"fmt"
	"strings"
)

// Fork-owned runtime brief sections: workspace knowledge, RTK token
// efficiency, and meeting (debate-turn) tasks. They live in their own file so
// upstream syncs only have to re-apply the small hook calls in
// buildMetaSkillContentSlim / writeOutput / classifyTask.

// writeKnowledgeCommands teaches agents the `multica knowledge` CLI so they can
// propose learnings for future runs in this workspace.
func writeKnowledgeCommands(b *strings.Builder) {
	b.WriteString("### Knowledge\n")
	b.WriteString("Share learnings with future agent runs in this workspace:\n")
	b.WriteString("- `multica knowledge propose \"<learning>\"` — Propose a knowledge entry for human review (becomes active after approval)\n")
	b.WriteString("- `multica knowledge list` — List active knowledge entries\n")
	b.WriteString("- `multica knowledge list --status pending` — List pending proposals\n\n")
}

// writeWorkspaceKnowledge injects the approved workspace rules (capped by the
// daemon to the most recent entries) as binding, numbered rules.
func writeWorkspaceKnowledge(b *strings.Builder, ctx TaskContextForEnv) {
	if len(ctx.WorkspaceKnowledge) == 0 {
		return
	}
	b.WriteString("## Workspace Knowledge\n\n")
	b.WriteString("These are workspace rules distilled from failures in previous agent runs. Each one was human-reviewed and approved. **Follow them** — they are not suggestions. Only deviate when the current task explicitly contradicts a rule, and say so in your output when you do.\n\n")
	for i, entry := range ctx.WorkspaceKnowledge {
		fmt.Fprintf(b, "%d. %s\n", i+1, entry)
	}
	b.WriteString("\nThis list is capped at the 20 most recent entries. If your task seems related to a past lesson that is not listed, run `rtk multica knowledge list` to see the full set of active rules.\n")
	b.WriteString("\nTo add new learnings for future agents, run:\n")
	b.WriteString("```\nrtk multica knowledge propose \"<your learning here>\"\n```\n\n")
}

// writeRTK tells agents to route shell commands through RTK (token-optimized
// CLI proxy). RTK passes unknown commands through unchanged, so the rule is
// always safe to follow.
func writeRTK(b *strings.Builder) {
	b.WriteString("## Token Efficiency — RTK\n\n")
	b.WriteString("**Golden rule: always prefix commands with `rtk`.** RTK filters verbose output to only what matters, saving 50–99% of tokens. If RTK has no filter for a command it passes it through unchanged, so `rtk` is always safe to use. This applies to every `multica` command shown in this brief.\n\n")
	b.WriteString("**Even in `&&` chains, use `rtk` on every command:**\n\n")
	b.WriteString("```bash\n# ✅ Correct\nrtk multica workspace get --output json && rtk git status\n# ❌ Wrong\nmultica workspace get --output json && git status\n```\n\n")
	b.WriteString("| Use | Instead of | Savings |\n")
	b.WriteString("| --- | --- | --- |\n")
	b.WriteString("| `rtk multica ...` | `multica ...` | 60-80% |\n")
	b.WriteString("| `rtk git diff ...` | `git diff ...` | 80% |\n")
	b.WriteString("| `rtk git log ...` | `git log ...` | 70% |\n")
	b.WriteString("| `rtk git status` | `git status` | 60% |\n")
	b.WriteString("| `rtk gh pr view ...` | `gh pr view ...` | 87% |\n")
	b.WriteString("| `rtk gh run list` | `gh run list` | 82% |\n")
	b.WriteString("| `rtk pnpm ...` | `pnpm ...` | 70-90% |\n")
	b.WriteString("| `rtk vitest ...` | `vitest ...` | 99% |\n")
	b.WriteString("| `rtk go test ...` | `go test ...` | 90% |\n")
	b.WriteString("| `rtk tsc ...` | `tsc ...` | 83% |\n")
	b.WriteString("| `rtk find ...` | `find ...` | 70% |\n")
	b.WriteString("| `rtk grep ...` | `grep ...` | 75% |\n")
	b.WriteString("| `rtk ls ...` | `ls ...` | 65% |\n")
	b.WriteString("| `rtk curl -s ...` | `curl -s ...` | 70% |\n")
	b.WriteString("| `rtk cat <file>` | `cat <file>` | 60% |\n\n")
}

// writeWorkflowMeeting emits the meeting (turn-based agent discussion)
// workflow. The per-turn prompt (daemon.buildMeetingPrompt) carries the topic,
// transcript and this agent's turn; the agent contributes by replying with
// text, and its stdout IS the turn. The guardrails keep a provider that drops
// the user message from falling back to the issue workflow.
func writeWorkflowMeeting(b *strings.Builder) {
	b.WriteString("**You are participating in a meeting (a turn-based discussion with other agents).** Read the topic and transcript in the message you just received, then contribute YOUR turn.\n\n")
	b.WriteString("Hard guardrails (apply even if the user message is missing):\n")
	b.WriteString("- Reply with your contribution as plain text on stdout — that text IS your turn in the meeting. Keep it focused (a few sentences): share your view, react to what others said, raise a concern, or propose a next step. Don't repeat points already made.\n")
	b.WriteString("- Do NOT call `multica issue get/status/comment add` or `multica issue create` for this task — a meeting is a discussion, not issue work. You MAY use read-only `multica` lookups (e.g. `issue get`, `issue list`) if you genuinely need context to contribute.\n")
	b.WriteString("- Do not check out repos or make code changes. When you've made your point, exit.\n\n")
}

// writeOutputMeeting emits the Output body for a meeting turn.
func writeOutputMeeting(b *strings.Builder) {
	b.WriteString("This is a meeting turn. Your final stdout IS your contribution to the discussion — it is captured automatically and shown to the other participants and the user as the meeting transcript.\n\n")
	b.WriteString("- Do NOT call `multica issue comment add` — there is no issue conversation here; the meeting transcript is the record.\n")
	b.WriteString("- Output only your spoken contribution as plain prose. No preamble like \"Here is my response\", no headings, no tool logs — just what you want to say in the meeting.\n")
}
