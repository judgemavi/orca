// Package prompts embeds all LLM system prompts used by Orca components.
// Edit the .md files in this directory to update prompt behaviour.
package prompts

import _ "embed"

//go:embed orchestrator.md
var Orchestrator string

//go:embed decompose.md
var Decompose string

//go:embed explore.md
var Explore string

//go:embed plan.md
var Plan string

//go:embed review.md
var Review string

//go:embed alignment.md
var Alignment string

//go:embed conflict_resolve.md
var ConflictResolve string

//go:embed budget_aware.md
var BudgetAware string

//go:embed output_style.md
var OutputStyle string
