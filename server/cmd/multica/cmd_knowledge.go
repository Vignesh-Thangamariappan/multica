package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var knowledgeCmd = &cobra.Command{
	Use:   "knowledge",
	Short: "Manage workspace knowledge",
	Long:  "Add, list, propose, and delete workspace knowledge entries shared across all agents.",
}

var knowledgeListCmd = &cobra.Command{
	Use:   "list",
	Short: "List workspace knowledge entries",
	RunE:  runKnowledgeList,
}

var knowledgeAddCmd = &cobra.Command{
	Use:   "add <content>",
	Short: "Add an active knowledge entry (immediately available to agents)",
	Args:  exactArgs(1),
	RunE:  runKnowledgeAdd,
}

var knowledgeProposeCmd = &cobra.Command{
	Use:   "propose <content>",
	Short: "Propose a knowledge entry for human review",
	Long:  "Propose a new knowledge entry. It will be in 'pending' status until a workspace admin approves it.",
	Args:  exactArgs(1),
	RunE:  runKnowledgePropose,
}

var knowledgeApproveCmd = &cobra.Command{
	Use:   "approve <id>",
	Short: "Approve a pending knowledge proposal",
	Args:  exactArgs(1),
	RunE:  runKnowledgeApprove,
}

var knowledgeRejectCmd = &cobra.Command{
	Use:   "reject <id>",
	Short: "Reject a pending knowledge proposal",
	Args:  exactArgs(1),
	RunE:  runKnowledgeReject,
}

var knowledgeDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a knowledge entry",
	Args:  exactArgs(1),
	RunE:  runKnowledgeDelete,
}

func init() {
	knowledgeCmd.AddCommand(knowledgeListCmd)
	knowledgeCmd.AddCommand(knowledgeAddCmd)
	knowledgeCmd.AddCommand(knowledgeProposeCmd)
	knowledgeCmd.AddCommand(knowledgeApproveCmd)
	knowledgeCmd.AddCommand(knowledgeRejectCmd)
	knowledgeCmd.AddCommand(knowledgeDeleteCmd)

	knowledgeListCmd.Flags().String("status", "active", "Filter by status: active, pending, or rejected")
	knowledgeListCmd.Flags().String("output", "table", "Output format: table or json")
	knowledgeAddCmd.Flags().String("output", "json", "Output format: table or json")
	knowledgeProposeCmd.Flags().String("output", "json", "Output format: table or json")

	knowledgeDeleteCmd.Flags().Bool("yes", false, "Skip confirmation prompt")
}

func runKnowledgeList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	status, _ := cmd.Flags().GetString("status")
	if status != "active" && status != "pending" && status != "rejected" {
		return fmt.Errorf("--status must be active, pending, or rejected")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var entries []map[string]any
	if err := client.GetJSON(ctx, "/api/knowledge?status="+status, &entries); err != nil {
		return fmt.Errorf("list knowledge: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, entries)
	}

	headers := []string{"ID", "STATUS", "CONTENT", "CREATED_AT"}
	rows := make([][]string, 0, len(entries))
	for _, e := range entries {
		content := strVal(e, "content")
		if len(content) > 80 {
			content = content[:77] + "..."
		}
		rows = append(rows, []string{
			strVal(e, "id"),
			strVal(e, "status"),
			content,
			strVal(e, "created_at"),
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runKnowledgeAdd(cmd *cobra.Command, args []string) error {
	content := strings.TrimSpace(args[0])
	if content == "" {
		return fmt.Errorf("content cannot be empty")
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var entry map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge", map[string]any{"content": content}, &entry); err != nil {
		return fmt.Errorf("add knowledge: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, entry)
	}
	fmt.Printf("Added knowledge entry: %s\n", strVal(entry, "id"))
	return nil
}

func runKnowledgePropose(cmd *cobra.Command, args []string) error {
	content := strings.TrimSpace(args[0])
	if content == "" {
		return fmt.Errorf("content cannot be empty")
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var entry map[string]any
	if err := client.PostJSON(ctx, "/api/knowledge/propose", map[string]any{"content": content}, &entry); err != nil {
		return fmt.Errorf("propose knowledge: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, entry)
	}
	fmt.Printf("Proposed knowledge entry: %s (pending review)\n", strVal(entry, "id"))
	return nil
}

func runKnowledgeApprove(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var entry map[string]any
	if err := client.PatchJSON(ctx, "/api/knowledge/"+args[0]+"/approve", nil, &entry); err != nil {
		return fmt.Errorf("approve knowledge: %w", err)
	}
	fmt.Printf("Approved knowledge entry: %s\n", strVal(entry, "id"))
	return nil
}

func runKnowledgeReject(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var entry map[string]any
	if err := client.PatchJSON(ctx, "/api/knowledge/"+args[0]+"/reject", nil, &entry); err != nil {
		return fmt.Errorf("reject knowledge: %w", err)
	}
	fmt.Printf("Rejected knowledge entry: %s\n", strVal(entry, "id"))
	return nil
}

func runKnowledgeDelete(cmd *cobra.Command, args []string) error {
	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		fmt.Printf("Delete knowledge entry %s? [y/N] ", args[0])
		var answer string
		fmt.Scanln(&answer)
		if strings.ToLower(answer) != "y" {
			fmt.Println("Cancelled.")
			return nil
		}
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/knowledge/"+args[0]); err != nil {
		return fmt.Errorf("delete knowledge: %w", err)
	}
	fmt.Printf("Deleted knowledge entry: %s\n", args[0])
	return nil
}
