package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var clickupCmd = &cobra.Command{
	Use:   "clickup",
	Short: "ClickUp integration",
	Long:  "Interact with the workspace's ClickUp integration (Phase 1: push issues as tasks, inspect links).",
}

var clickupPushCmd = &cobra.Command{
	Use:   "push <issue-id>",
	Short: "Create a ClickUp task from an issue",
	Long:  "Creates a task in the ClickUp list linked to the issue's project and records the pair. Fails if the issue is already linked or its project has no list link.",
	Args:  exactArgs(1),
	RunE:  runClickUpPush,
}

var clickupLinksCmd = &cobra.Command{
	Use:   "links",
	Short: "List project ↔ ClickUp list links",
	RunE:  runClickUpLinks,
}

func init() {
	clickupCmd.AddCommand(clickupPushCmd)
	clickupCmd.AddCommand(clickupLinksCmd)
	clickupPushCmd.Flags().String("output", "json", "Output format: table or json")
	clickupLinksCmd.Flags().String("output", "table", "Output format: table or json")
}

func runClickUpPush(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var out map[string]any
	if err := client.PostJSON(ctx, "/api/issues/"+args[0]+"/clickup", nil, &out); err != nil {
		return fmt.Errorf("clickup push: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, out)
	}
	fmt.Printf("Created ClickUp task %s: %s\n", strVal(out, "task_id"), strVal(out, "task_url"))
	return nil
}

func runClickUpLinks(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var links []map[string]any
	if err := client.GetJSON(ctx, "/api/clickup/links", &links); err != nil {
		return fmt.Errorf("clickup links: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, links)
	}
	headers := []string{"ID", "PROJECT_ID", "LIST_ID", "LIST_NAME", "SYNC", "CREATED_AT"}
	rows := make([][]string, 0, len(links))
	for _, l := range links {
		sync := "off"
		if b, ok := l["sync_enabled"].(bool); ok && b {
			sync = "on"
		}
		rows = append(rows, []string{
			strVal(l, "id"),
			strVal(l, "project_id"),
			strVal(l, "list_id"),
			strVal(l, "list_name"),
			sync,
			strVal(l, "created_at"),
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}
