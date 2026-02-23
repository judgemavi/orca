package commands

import (
	"fmt"
	"os"
)

func errorf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
}

func warnf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "warning: "+format+"\n", args...)
}
