package api

import (
	"net/http"
	"time"
)

// MonitorAlert is a transient monitor event emitted by runtime safeguards.
type MonitorAlert struct {
	Type      string    `json:"type"` // "stuck", "conflict"
	TaskID    string    `json:"task_id"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
}

func (s *Server) AddMonitorAlert(alert MonitorAlert) {
	s.monitorMu.Lock()
	s.monitorAlerts = append(s.monitorAlerts, alert)
	if len(s.monitorAlerts) > 100 {
		s.monitorAlerts = s.monitorAlerts[len(s.monitorAlerts)-100:]
	}
	s.monitorMu.Unlock()

	s.hub.Broadcast(Event{Type: "monitor_alert", Data: alert})
}

func (s *Server) handleMonitorAlerts(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	s.monitorMu.Lock()
	alerts := make([]MonitorAlert, len(s.monitorAlerts))
	copy(alerts, s.monitorAlerts)
	s.monitorMu.Unlock()

	jsonOK(w, alerts)
}
