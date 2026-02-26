package driver

// Driver defines a tool's capabilities and knows how to interact with it.
type Driver interface {
	// Identity
	Name() string
	Binary() string
	Models() []string

	// Arg construction
	HeadlessArgs(prompt, model, dir string) []string
	ResumeArgs(sessionID, feedback, model, dir string) []string

	// Streaming NDJSON event parsing
	ParseEvent(line []byte) (Event, error)

	// FormatEvent renders a single NDJSON line into human-readable output.
	// Returns empty string for events that should be hidden.
	FormatEvent(line []byte) string

	// Session ID extraction from events
	ParseSessionID(events []Event) string
}

// SupervisorDriver defines interactive launch args used only by supervisor sessions.
type SupervisorDriver interface {
	InteractiveArgs(mcpConfig, allowedTools, context, model string) []string
}

// Event represents a parsed streaming event from a tool.
type Event struct {
	Type      EventType
	Text      string
	Cost      *Cost
	SessionID string
	Raw       string
}

type EventType int

const (
	EventUnknown EventType = iota
	EventText
	EventCost
	EventSession
	EventStatus
	EventError
)

type Cost struct {
	InputTokens  int64
	OutputTokens int64
	TotalCost    float64
}
