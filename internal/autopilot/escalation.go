package autopilot

// ShouldEscalate checks if a task has failed enough times to need user intervention.
func (s *Supervisor) ShouldEscalate(taskID string, threshold int) bool {
	return s.retryCount[taskID] >= threshold
}

// RecordFailure increments the retry count for a task.
func (s *Supervisor) RecordFailure(taskID string) {
	s.retryCount[taskID]++
}
