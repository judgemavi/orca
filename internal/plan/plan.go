// Package plan generates markdown implementation plans for tasks using a headless LLM tool.
package plan

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/prompts"
)

// Generator produces markdown implementation plans for tasks.
type Generator struct {
	toolName     string
	driver       driver.Driver
	model        string
	timeout      time.Duration
	repoDir      string
	interactions *interaction.Store
	memory       *memory.Store
	syncer       *memory.Syncer
	taskStore    *task.Store
}

// New creates a plan Generator.
func New(toolName string, d driver.Driver, model string, timeout time.Duration, repoDir string, interactions ...*interaction.Store) *Generator {
	var store *interaction.Store
	if len(interactions) > 0 {
		store = interactions[0]
	}
	return &Generator{toolName: toolName, driver: d, model: model, timeout: timeout, repoDir: repoDir, interactions: store}
}

// WithMemory attaches an optional memory store for prompt-time retrieval.
func (g *Generator) WithMemory(store *memory.Store) *Generator {
	g.memory = store
	return g
}

func (g *Generator) WithSyncer(syncer *memory.Syncer) *Generator {
	g.syncer = syncer
	return g
}

func (g *Generator) WithTaskStore(store *task.Store) *Generator {
	g.taskStore = store
	return g
}

func (g *Generator) Generate(taskID, title, description string) (string, error) {
	return g.generate(taskID, title, description, "")
}

func (g *Generator) GenerateWithModel(taskID, title, description, model string) (string, error) {
	return g.generate(taskID, title, description, model)
}

func (g *Generator) generate(taskID, title, description, model string) (string, error) {
	if g.syncer != nil {
		if _, err := g.syncer.Sync(); err != nil {
			return "", fmt.Errorf("sync memory: %w", err)
		}
	}

	contextSection := ""
	usedMemoryIDs := []string{}
	usedProvenanceHashes := []string{}
	if g.memory != nil {
		retriever := memory.NewRetriever(g.memory, g.taskStore, g.interactions, g.repoDir).WithSyncer(g.syncer)
		retrieved, err := retriever.Retrieve(memory.RetrievalOpts{
			TaskTitle:       title,
			TaskDescription: description,
			ExcludeTaskID:   taskID,
		})
		if err != nil {
			slog.Warn("plan: retrieval failed", "task_id", taskID, "err", err)
		} else {
			contextSection = retriever.BuildPromptSection(retrieved)
			usedMemoryIDs, usedProvenanceHashes = collectMemoryUsage(retrieved)
		}
	}

	prompt := buildPlanPrompt(contextSection, title, description)
	selectedModel := g.model
	if model != "" {
		selectedModel = model
	}

	adapter := worker.NewAdapter(g.driver, selectedModel, g.timeout)
	var (
		stdout        string
		exitCode      = -1
		stderr        string
		generatedPlan string
	)
	taskRef := taskID
	_, err := interaction.RunWithTracking(
		g.interactions,
		&taskRef,
		"plan",
		g.toolName,
		adapter,
		func() (*worker.Result, error) {
			return adapter.Execute(context.Background(), "plan", prompt, g.repoDir)
		},
		interaction.WithAfterRun(func(result *worker.Result, _ error) {
			if result != nil {
				stdout = result.Stdout
				exitCode = result.ExitCode
				stderr = result.Stderr
			}
			generatedPlan = parsePlanResponse(stdout)
		}),
		interaction.WithFinishFn(func(result *worker.Result, runErr error) (string, []interaction.FinishOption) {
			status := "completed"
			opts := []interaction.FinishOption{}
			if result != nil {
				opts = append(opts, interaction.WithCost(result.InputTokens, result.OutputTokens, result.TotalCost))
			}
			if runErr != nil {
				status = "failed"
				opts = append(opts, interaction.WithError(runErr.Error()))
			} else if exitCode != 0 {
				status = "failed"
				opts = append(opts, interaction.WithError(fmt.Sprintf("planner exited %d: %s", exitCode, stderr)))
			} else if strings.TrimSpace(generatedPlan) == "" {
				status = "failed"
				opts = append(opts, interaction.WithError("planner returned empty plan"))
			} else if generatedPlan != "" {
				opts = append(opts, interaction.WithDiff(generatedPlan))
			}
			if status == "completed" {
				if qualityJSON, err := buildMemoryQualityJSON(usedMemoryIDs, usedProvenanceHashes); err != nil {
					slog.Warn("plan: build memory quality metadata failed", "task_id", taskID, "err", err)
				} else {
					opts = append(opts, interaction.WithQuality(qualityJSON))
				}
			}
			return status, opts
		}),
	)
	if err != nil {
		return "", fmt.Errorf("execute planner: %w", err)
	}
	if exitCode != 0 {
		return "", fmt.Errorf("planner exited %d: %s", exitCode, stderr)
	}
	if strings.TrimSpace(generatedPlan) == "" {
		return "", fmt.Errorf("planner returned empty plan")
	}
	g.associateTaskFiles(taskID, generatedPlan)
	return generatedPlan, nil
}

// parsePlanResponse accepts markdown output from the planner template.
func parsePlanResponse(stdout string) string {
	return strings.TrimSpace(stdout)
}

func buildPlanPrompt(contextSection, title, description string) string {
	contextBlock := ""
	if strings.TrimSpace(contextSection) != "" {
		contextBlock = strings.TrimSpace(contextSection) + "\n\n"
	}
	prompt := fmt.Sprintf(prompts.Plan, contextBlock, title, description)
	return strings.TrimSpace(prompts.OutputStyle) + "\n\n---\n\n" + prompt
}

type memoryUsageMetadata struct {
	UsedMemoryIDs        []string `json:"used_memory_ids"`
	UsedProvenanceHashes []string `json:"used_provenance_hashes"`
}

func buildMemorySection(entries []*memory.Entry) (section string, ids []string, provenanceHashes []string) {
	if len(entries) == 0 {
		return "", []string{}, []string{}
	}

	idSeen := make(map[string]struct{}, len(entries))
	hashSeen := make(map[string]struct{}, len(entries))
	lines := make([]string, 0, len(entries)*6+2)
	lines = append(lines, "## Relevant Memory", "")

	item := 0
	for _, entry := range entries {
		if entry == nil {
			continue
		}
		content := strings.TrimSpace(entry.Content)
		if content == "" {
			continue
		}
		item++
		lines = append(lines, fmt.Sprintf("%d. %s", item, content))
		lines = append(lines, fmt.Sprintf("   - id: %s", entry.ID))
		lines = append(lines, fmt.Sprintf("   - category: %s", strings.TrimSpace(entry.Category)))
		lines = append(lines, fmt.Sprintf("   - confidence: %.2f", entry.Confidence))
		lines = append(lines, fmt.Sprintf("   - provenance_hash: %s", strings.TrimSpace(entry.ProvenanceHash)))
		if len(entry.Tags) > 0 {
			lines = append(lines, fmt.Sprintf("   - tags: %s", strings.Join(entry.Tags, ", ")))
		}

		if id := strings.TrimSpace(entry.ID); id != "" {
			if _, ok := idSeen[id]; !ok {
				idSeen[id] = struct{}{}
				ids = append(ids, id)
			}
		}
		if hash := strings.TrimSpace(entry.ProvenanceHash); hash != "" {
			if _, ok := hashSeen[hash]; !ok {
				hashSeen[hash] = struct{}{}
				provenanceHashes = append(provenanceHashes, hash)
			}
		}
	}

	if item == 0 {
		return "", []string{}, []string{}
	}
	return strings.Join(lines, "\n"), ids, provenanceHashes
}

func buildMemoryQualityJSON(ids, provenanceHashes []string) (string, error) {
	metadata := memoryUsageMetadata{
		UsedMemoryIDs:        normalizeUniqueStrings(ids),
		UsedProvenanceHashes: normalizeUniqueStrings(provenanceHashes),
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return "", fmt.Errorf("marshal memory usage metadata: %w", err)
	}
	return string(raw), nil
}

func normalizeUniqueStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		v := strings.TrimSpace(value)
		if v == "" {
			continue
		}
		if _, exists := seen[v]; exists {
			continue
		}
		seen[v] = struct{}{}
		normalized = append(normalized, v)
	}
	return normalized
}

func collectMemoryUsage(retrieved *memory.RetrievalResult) ([]string, []string) {
	if retrieved == nil {
		return []string{}, []string{}
	}
	ids := make([]string, 0, 16)
	hashes := make([]string, 0, 16)
	seenIDs := map[string]struct{}{}
	seenHashes := map[string]struct{}{}

	appendEntry := func(entry *memory.Entry) {
		if entry == nil {
			return
		}
		if id := strings.TrimSpace(entry.ID); id != "" {
			if _, ok := seenIDs[id]; !ok {
				seenIDs[id] = struct{}{}
				ids = append(ids, id)
			}
		}
		if hash := strings.TrimSpace(entry.ProvenanceHash); hash != "" {
			if _, ok := seenHashes[hash]; !ok {
				seenHashes[hash] = struct{}{}
				hashes = append(hashes, hash)
			}
		}
	}

	appendEntry(retrieved.Summary)
	for _, entry := range retrieved.FileMatches {
		appendEntry(entry)
	}
	for _, entry := range retrieved.Relevant {
		appendEntry(entry)
	}
	return ids, hashes
}

var planFilePathPattern = regexp.MustCompile(`(?:^|[^A-Za-z0-9_./-])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`)

func (g *Generator) associateTaskFiles(taskID, planContent string) {
	if g.taskStore == nil || strings.TrimSpace(taskID) == "" {
		return
	}
	paths := extractPlanFilePaths(planContent)
	if len(paths) == 0 {
		return
	}
	if err := g.taskStore.AssociateFiles(taskID, paths); err != nil {
		slog.Warn("plan: associate task files failed", "task_id", taskID, "err", err)
	}
}

func extractPlanFilePaths(planContent string) []string {
	matches := planFilePathPattern.FindAllStringSubmatch(planContent, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(matches))
	paths := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		path := strings.TrimSpace(strings.Trim(m[1], ".,:;()[]{}<>\"'`"))
		if path == "" || strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	if len(paths) == 0 {
		return nil
	}
	return paths
}
