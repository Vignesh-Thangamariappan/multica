package daemon

import (
	"fmt"
	"strings"
)

// BuildPrompt constructs the task prompt for an agent CLI.
// Keep this minimal — detailed instructions live in CLAUDE.md / AGENTS.md
// injected by execenv.InjectRuntimeConfig.
func BuildPrompt(task Task) string {
	if task.ChatSessionID != "" {
		return buildChatPrompt(task)
	}
	if task.RetryCount > 0 {
		return buildRetryPrompt(task)
	}
	if task.TriggerCommentID != "" {
		return buildCommentPrompt(task)
	}
	var b strings.Builder
	b.WriteString("You are running as a local coding agent for a Multica workspace.\n\n")
	fmt.Fprintf(&b, "Your assigned issue ID is: %s\n\n", task.IssueID)
	fmt.Fprintf(&b, "Start by running `rtk multica issue get %s --output json` to understand your task, then complete it.\n", task.IssueID)
	return b.String()
}

// buildRetryPrompt constructs a self-correction prompt when a previous attempt failed.
func buildRetryPrompt(task Task) string {
	var b strings.Builder
	b.WriteString("You are running as a local coding agent for a Multica workspace.\n\n")
	fmt.Fprintf(&b, "Your assigned issue ID is: %s\n\n", task.IssueID)
	b.WriteString("Your previous attempt on this task failed. Here is the error:\n\n")
	fmt.Fprintf(&b, "```\n%s\n```\n\n", task.RetryError)
	b.WriteString("Reflect on what went wrong, correct your approach, and try again.\n")
	fmt.Fprintf(&b, "Run `rtk multica issue get %s --output json` to review the task, then complete it successfully.\n", task.IssueID)
	return b.String()
}

// buildCommentPrompt constructs a prompt for comment-triggered tasks.
// The triggering comment content is embedded directly so the agent cannot
// miss it, even when stale output files exist in a reused workdir.
func buildCommentPrompt(task Task) string {
	var b strings.Builder
	b.WriteString("You are running as a local coding agent for a Multica workspace.\n\n")
	fmt.Fprintf(&b, "Your assigned issue ID is: %s\n\n", task.IssueID)
	if task.TriggerCommentContent != "" {
		b.WriteString("[NEW COMMENT] A user just left a new comment that triggered this task. You MUST respond to THIS comment:\n\n")
		fmt.Fprintf(&b, "> %s\n\n", task.TriggerCommentContent)
	}
	b.WriteString("**IMPORTANT — review before acting:**\n")
	fmt.Fprintf(&b, "1. Run `rtk multica issue get %s --output json` to check the current issue status and description\n", task.IssueID)
	fmt.Fprintf(&b, "2. Run `rtk multica issue comment list %s --output json` to read the full conversation and understand what was already done\n", task.IssueID)
	b.WriteString("3. If the work requested was already completed in a previous session, do NOT redo it — just acknowledge it and reply to the comment with a summary of what was done\n")
	b.WriteString("4. Only do new or additional work if the comment explicitly asks for something that hasn't been done yet\n")
	fmt.Fprintf(&b, "5. Always reply to the triggering comment (ID: `%s`) with your response\n", task.TriggerCommentID)
	return b.String()
}

// buildChatPrompt constructs a prompt for interactive chat tasks.
func buildChatPrompt(task Task) string {
	var b strings.Builder
	b.WriteString("You are running as a chat assistant for a Multica workspace.\n")
	b.WriteString("A user is chatting with you directly. Respond to their message.\n\n")
	fmt.Fprintf(&b, "User message:\n%s\n", task.ChatMessage)
	return b.String()
}
