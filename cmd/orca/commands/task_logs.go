package commands

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/spf13/cobra"
)

func (r *Registry) runTaskLogs(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	taskID, err := resolveTaskID(store, args[0])
	if err != nil {
		return err
	}

	phase, _ := cmd.Flags().GetString("phase")
	phase = strings.ToLower(strings.TrimSpace(phase))
	attempt, _ := cmd.Flags().GetInt("attempt")
	raw, _ := cmd.Flags().GetBool("raw")
	follow, _ := cmd.Flags().GetBool("follow")
	jsonOut, _ := cmd.Flags().GetBool("json")

	if attempt < 0 {
		return fmt.Errorf("--attempt must be >= 0")
	}
	if attempt > 0 && phase == "" {
		return fmt.Errorf("--attempt requires --phase")
	}
	if (raw || follow) && phase == "" {
		return fmt.Errorf("--raw and --follow require --phase")
	}

	is := interaction.NewStore(db, ".orca/interactions")
	if phase == "" {
		return printTaskInteractionList(is, taskID, jsonOut)
	}

	return printTaskInteractionContent(cmd, is, taskID, phase, attempt, raw, follow, jsonOut)
}

func printTaskInteractionList(is *interaction.Store, taskID string, jsonOut bool) error {
	items, err := is.List(taskID)
	if err != nil {
		return fmt.Errorf("list interactions: %w", err)
	}
	if len(items) == 0 {
		fmt.Println("No interactions found.")
		return nil
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].StartedAt.Equal(items[j].StartedAt) {
			if items[i].Phase == items[j].Phase {
				return items[i].Attempt < items[j].Attempt
			}
			return items[i].Phase < items[j].Phase
		}
		return items[i].StartedAt.Before(items[j].StartedAt)
	})

	if jsonOut {
		payload, err := json.MarshalIndent(items, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal interactions: %w", err)
		}
		fmt.Println(string(payload))
		return nil
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "PHASE\tATTEMPT\tTOOL\tSTATUS\tDURATION\tCOST\tTOKENS")
	for _, in := range items {
		fmt.Fprintf(
			tw,
			"%s\t%d\t%s\t%s\t%s\t%s\t%s\n",
			in.Phase,
			in.Attempt,
			in.Tool,
			in.Status,
			interactionDuration(in),
			interactionCost(in),
			interactionTokens(in),
		)
	}
	return tw.Flush()
}

func printTaskInteractionContent(
	cmd *cobra.Command,
	is *interaction.Store,
	taskID, phase string,
	attempt int,
	raw, follow, jsonOut bool,
) error {
	items, err := is.ListByPhase(taskID, phase)
	if err != nil {
		return fmt.Errorf("list interactions by phase: %w", err)
	}
	if len(items) == 0 {
		return fmt.Errorf("no interactions found for phase %q", phase)
	}

	selected, err := selectInteractionAttempt(items, attempt)
	if err != nil {
		return err
	}

	rawContent, err := is.ReadLog(selected.ID)
	if err != nil {
		return fmt.Errorf("read interaction log: %w", err)
	}

	content := rawContent
	if !raw {
		content = driver.FormatLog(selected.Tool, rawContent)
	}

	if jsonOut {
		payload := map[string]any{
			"interaction": selected,
			"content":     content,
			"raw":         raw,
		}
		data, marshalErr := json.MarshalIndent(payload, "", "  ")
		if marshalErr != nil {
			return fmt.Errorf("marshal interaction log: %w", marshalErr)
		}
		fmt.Println(string(data))
	} else {
		fmt.Printf(
			"Phase: %s  Attempt: %d  Tool: %s  Status: %s  Duration: %s\n\n",
			selected.Phase,
			selected.Attempt,
			selected.Tool,
			selected.Status,
			interactionDuration(selected),
		)
		if !raw {
			fmt.Println("---")
		}
		if content != "" {
			fmt.Print(content)
			if !strings.HasSuffix(content, "\n") {
				fmt.Println()
			}
		}
	}

	if !follow || selected.Status != "running" {
		return nil
	}

	offset := int64(len(rawContent))
	pending := ""

	for {
		select {
		case <-cmd.Context().Done():
			return nil
		default:
		}

		chunk, nextOffset, readErr := readInteractionDelta(selected.LogPath, offset)
		if readErr != nil {
			return fmt.Errorf("read interaction log delta: %w", readErr)
		}
		offset = nextOffset

		if chunk != "" {
			if raw {
				fmt.Print(chunk)
			} else {
				formatted := formatInteractionDelta(selected.Tool, chunk, &pending)
				if formatted != "" {
					fmt.Print(formatted)
				}
			}
		}

		current, getErr := is.Get(selected.ID)
		if getErr != nil {
			return fmt.Errorf("get interaction: %w", getErr)
		}
		if current.Status == "completed" || current.Status == "failed" {
			finalChunk, _, finalErr := readInteractionDelta(current.LogPath, offset)
			if finalErr == nil {
				if finalChunk != "" {
					if raw {
						fmt.Print(finalChunk)
					} else {
						formatted := formatInteractionDelta(current.Tool, finalChunk, &pending)
						if formatted != "" {
							fmt.Print(formatted)
						}
					}
				}
			}

			if !raw && pending != "" {
				if tail := driver.FormatLine(current.Tool, []byte(pending)); tail != "" {
					fmt.Print(tail)
				}
			}
			return nil
		}

		time.Sleep(500 * time.Millisecond)
	}
}

func selectInteractionAttempt(items []interaction.Interaction, attempt int) (interaction.Interaction, error) {
	if attempt == 0 {
		return items[0], nil
	}
	for _, in := range items {
		if in.Attempt == attempt {
			return in, nil
		}
	}
	return interaction.Interaction{}, fmt.Errorf("no interaction found for attempt %d", attempt)
}

func interactionDuration(in interaction.Interaction) string {
	if in.DurationMS != nil {
		d := time.Duration(*in.DurationMS) * time.Millisecond
		if d < 0 {
			d = 0
		}
		return d.Round(time.Second).String()
	}

	end := time.Now().UTC()
	if in.FinishedAt != nil {
		end = *in.FinishedAt
	}
	d := end.Sub(in.StartedAt)
	if d < 0 {
		d = 0
	}
	return d.Round(time.Second).String()
}

func interactionCost(in interaction.Interaction) string {
	if in.Status == "running" {
		return "-"
	}
	if in.EstimatedCost <= 0 {
		return "-"
	}
	return fmt.Sprintf("$%.2f", in.EstimatedCost)
}

func interactionTokens(in interaction.Interaction) string {
	if in.Status == "running" {
		return "-"
	}
	if in.InputTokens == 0 && in.OutputTokens == 0 {
		return "-"
	}
	return fmt.Sprintf("%s in / %s out", formatCompactTokens(in.InputTokens), formatCompactTokens(in.OutputTokens))
}

func formatCompactTokens(n int64) string {
	if n >= 1000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	return fmt.Sprintf("%d", n)
}

func formatInteractionDelta(toolName, chunk string, pendingLine *string) string {
	if pendingLine == nil {
		return ""
	}
	buffer := *pendingLine + chunk
	lastNewline := strings.LastIndexByte(buffer, '\n')
	if lastNewline < 0 {
		*pendingLine = buffer
		return ""
	}

	complete := buffer[:lastNewline+1]
	*pendingLine = buffer[lastNewline+1:]

	var out strings.Builder
	for _, line := range strings.Split(complete, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		formatted := driver.FormatLine(toolName, []byte(line))
		if formatted == "" {
			continue
		}
		out.WriteString(formatted)
	}
	return out.String()
}

func readInteractionDelta(path string, offset int64) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", offset, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return "", offset, err
	}
	if offset > stat.Size() {
		offset = stat.Size()
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", offset, err
	}

	b, err := io.ReadAll(f)
	if err != nil {
		return "", offset, err
	}
	return string(b), offset + int64(len(b)), nil
}
