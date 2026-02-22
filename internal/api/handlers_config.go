package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/jasjeetmavi/pod/internal/config"
)

// ========== Config ==========

type configPatchRequest struct {
	Defaults     *config.DefaultsConfig `json:"defaults,omitempty"`
	Orchestrator *orchestratorPatch     `json:"orchestrator,omitempty"`
	Workers      *workersPatch          `json:"workers,omitempty"`
}

type orchestratorPatch struct {
	CostBudget      *float64                      `json:"cost_budget,omitempty"`
	SupervisorTool  *string                       `json:"supervisor_tool,omitempty"`
	SupervisorModel *string                       `json:"supervisor_model,omitempty"`
	Phases          map[string]config.PhaseConfig `json:"phases,omitempty"`
}

type workersPatch struct {
	MaxParallel *int `json:"max_parallel,omitempty"`
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, s.cfg)
}

func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var body configPatchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	if body.Defaults != nil {
		if body.Defaults.Tool != "" {
			if _, ok := s.cfg.Tools[body.Defaults.Tool]; !ok {
				jsonError(w, fmt.Sprintf("unknown tool %q for defaults.tool", body.Defaults.Tool), 400)
				return
			}
		}
		s.cfg.Defaults = *body.Defaults
	}

	if body.Orchestrator != nil {
		if body.Orchestrator.CostBudget != nil {
			s.cfg.Orchestrator.CostBudget = *body.Orchestrator.CostBudget
		}
		if body.Orchestrator.SupervisorTool != nil {
			if *body.Orchestrator.SupervisorTool != "" {
				if _, ok := s.cfg.Tools[*body.Orchestrator.SupervisorTool]; !ok {
					jsonError(w, fmt.Sprintf("unknown tool %q for orchestrator.supervisor_tool", *body.Orchestrator.SupervisorTool), 400)
					return
				}
			}
			s.cfg.Orchestrator.SupervisorTool = *body.Orchestrator.SupervisorTool
		}
		if body.Orchestrator.SupervisorModel != nil {
			s.cfg.Orchestrator.SupervisorModel = *body.Orchestrator.SupervisorModel
		}
		if body.Orchestrator.Phases != nil {
			for phase, phaseCfg := range body.Orchestrator.Phases {
				if phaseCfg.Tool != "" {
					if _, ok := s.cfg.Tools[phaseCfg.Tool]; !ok {
						jsonError(w, fmt.Sprintf("unknown tool %q for orchestrator.phases.%s.tool", phaseCfg.Tool, phase), 400)
						return
					}
				}

				if phaseCfg.Model != "" {
					toolName := phaseCfg.Tool
					if toolName == "" {
						toolName = s.cfg.Defaults.Tool
					}
					if toolName == "" {
						jsonError(w, fmt.Sprintf("orchestrator.phases.%s.model requires a tool (phase tool or defaults.tool)", phase), 400)
						return
					}
					toolCfg, ok := s.cfg.Tools[toolName]
					if !ok {
						jsonError(w, fmt.Sprintf("unknown tool %q for orchestrator.phases.%s.model", toolName, phase), 400)
						return
					}
					if len(toolCfg.Models) == 0 {
						jsonError(w, fmt.Sprintf("tool %q has no models configured for orchestrator.phases.%s.model", toolName, phase), 400)
						return
					}
					if !containsString(toolCfg.Models, phaseCfg.Model) {
						jsonError(w, fmt.Sprintf("unknown model %q for tool %q in orchestrator.phases.%s.model", phaseCfg.Model, toolName, phase), 400)
						return
					}
				}
			}
			s.cfg.Orchestrator.Phases = body.Orchestrator.Phases
		}
	}

	if body.Workers != nil {
		if body.Workers.MaxParallel != nil {
			s.cfg.Workers.MaxParallel = *body.Workers.MaxParallel
		}
	}

	cfgPath := filepath.Join(".pod", "pod.yaml")
	if err := s.cfg.Save(cfgPath); err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, s.cfg)
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
