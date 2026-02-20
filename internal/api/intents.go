package api

import "strings"

// Intent represents a parsed user intent from chat input.
type Intent struct {
	Action string
	Args   map[string]string
}

// ParseIntent does simple pattern matching on the message to determine intent.
func ParseIntent(message string) Intent {
	msg := strings.TrimSpace(strings.ToLower(message))
	tokens := strings.Fields(msg)
	if len(tokens) == 0 {
		return Intent{Action: "unknown"}
	}

	first := tokens[0]
	rest := strings.TrimSpace(strings.TrimPrefix(msg, first))

	switch {
	// Models
	case first == "models":
		tool := ""
		if len(tokens) > 1 {
			tool = tokens[1]
		}
		return Intent{Action: "models", Args: map[string]string{"tool": tool}}

	// Backlog reopen (must come before generic backlog listing)
	case strings.HasPrefix(msg, "backlog reopen ") && len(tokens) > 2:
		return Intent{Action: "task.reopen", Args: map[string]string{"ids": strings.Join(tokens[2:], " ")}}
	case strings.HasPrefix(msg, "backlog show ") && len(tokens) > 2:
		return Intent{Action: "task.show", Args: map[string]string{"id": tokens[2]}}
	case strings.HasPrefix(msg, "show task ") && len(tokens) > 2:
		return Intent{Action: "task.show", Args: map[string]string{"id": tokens[2]}}
	case strings.HasPrefix(msg, "show ") && len(tokens) > 1:
		return Intent{Action: "task.show", Args: map[string]string{"id": tokens[1]}}
	case strings.HasPrefix(msg, "backlog plan ") && len(tokens) > 2:
		return Intent{Action: "task.plan", Args: map[string]string{"id": tokens[2]}}
	case strings.HasPrefix(msg, "plan task ") && len(tokens) > 2:
		return Intent{Action: "task.plan", Args: map[string]string{"id": tokens[2]}}

	// Status
	case first == "status" || msg == "show status":
		return Intent{Action: "status"}

	// Task listing
	case first == "backlog" || first == "tasks" || msg == "list tasks":
		return Intent{Action: "task.list"}

	// Task create
	case first == "add" && len(tokens) > 1:
		title := rest
		if strings.HasPrefix(rest, "task ") {
			title = strings.TrimPrefix(rest, "task ")
		}
		return Intent{Action: "task.create", Args: map[string]string{"title": title}}

	// Task edit
	case first == "edit" && len(tokens) > 1:
		return Intent{Action: "task.update", Args: map[string]string{"id": tokens[1], "rest": strings.Join(tokens[2:], " ")}}

	// Task delete
	case first == "delete" && len(tokens) > 1:
		return Intent{Action: "task.delete", Args: map[string]string{"id": tokens[1]}}

	// Sprint plan (must be before generic plan)
	case msg == "plan sprint" || msg == "sprint plan":
		return Intent{Action: "sprint.plan"}

	// Plan / decompose
	case first == "plan" || first == "decompose":
		if rest == "" {
			return Intent{Action: "sprint.plan"}
		}
		return Intent{Action: "plan", Args: map[string]string{"goal": rest}}

	// Plan accept
	case first == "approve" || first == "accept":
		return Intent{Action: "plan.accept"}

	// Explore
	case first == "explore":
		if rest != "" {
			return Intent{Action: "plan", Args: map[string]string{"goal": rest}}
		}
		return Intent{Action: "explore"}

	// Sprint commands
	case msg == "sprint status":
		return Intent{Action: "sprint.status"}
	case first == "assign" && len(tokens) > 1:
		return Intent{Action: "sprint.assign", Args: map[string]string{"ids": strings.Join(tokens[1:], " ")}}
	case strings.HasPrefix(msg, "sprint assign ") && len(tokens) > 2:
		return Intent{Action: "sprint.assign", Args: map[string]string{"ids": strings.Join(tokens[2:], " ")}}
	case first == "unassign" && len(tokens) > 1:
		return Intent{Action: "sprint.unassign", Args: map[string]string{"ids": strings.Join(tokens[1:], " ")}}
	case strings.HasPrefix(msg, "sprint unassign ") && len(tokens) > 2:
		return Intent{Action: "sprint.unassign", Args: map[string]string{"ids": strings.Join(tokens[2:], " ")}}
	case msg == "sprint cancel":
		return Intent{Action: "sprint.cancel"}
	case msg == "sprint reset":
		return Intent{Action: "sprint.reset"}
	case first == "start" || first == "run" || msg == "sprint start":
		return Intent{Action: "sprint.start"}
	case first == "reopen" && len(tokens) > 1:
		return Intent{Action: "task.reopen", Args: map[string]string{"ids": strings.Join(tokens[1:], " ")}}

	// Cancel / reset (standalone)
	case first == "cancel":
		return Intent{Action: "sprint.cancel"}
	case first == "reset":
		return Intent{Action: "sprint.reset"}

	// Review
	case msg == "auto review":
		return Intent{Action: "review.auto"}
	case first == "review":
		return Intent{Action: "review"}

	// Integrate
	case first == "integrate" || first == "merge":
		return Intent{Action: "integrate"}

	// Costs
	case first == "costs" || first == "budget":
		return Intent{Action: "costs"}

	// Config
	case first == "config" || first == "settings":
		return Intent{Action: "config"}

	// Cleanup
	case first == "cleanup":
		return Intent{Action: "cleanup"}

	// Autopilot
	case first == "autopilot":
		return Intent{Action: "autopilot", Args: map[string]string{"goal": rest}}

	// Stop / abort
	case first == "stop" || first == "abort":
		return Intent{Action: "autopilot.stop"}

	// Continue / yes
	case first == "continue" || first == "yes":
		return Intent{Action: "autopilot.respond"}

	// Help
	case first == "help":
		return Intent{Action: "help"}

	default:
		return Intent{Action: "unknown", Args: map[string]string{"message": message}}
	}
}
