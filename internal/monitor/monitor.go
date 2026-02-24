package monitor

import "context"

// Monitor defines lifecycle hooks for runtime task monitors.
type Monitor interface {
	Start(ctx context.Context) error
	Stop() error
}
