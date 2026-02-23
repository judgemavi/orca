package banner

import (
	"fmt"
	"os"
)

const reset = "\033[0m"

// Print displays the Orca ASCII art banner to stdout.
func Print() {
	if useColor() {
		printColored()
	} else {
		printPlain()
	}
}

func printPlain() {
	fmt.Println(`    ██████  ██████   ██████  █████ `)
	fmt.Println(`   ██    ██ ██   ██ ██      ██   ██`)
	fmt.Println(`   ██    ██ ██████  ██      ███████`)
	fmt.Println(`   ██    ██ ██   ██ ██      ██   ██`)
	fmt.Println(`    ██████  ██   ██  ██████ ██   ██`)
	fmt.Println(`        multi-agent orchestrator`)
	fmt.Println()
}

func printColored() {
	// Warm gradient top-to-bottom, inspired by Claude's orange palette
	g := [5]string{
		"\033[38;5;231m", // white (orca belly)
		"\033[38;5;153m", // light blue
		"\033[38;5;75m",  // ocean blue
		"\033[38;5;33m",  // deep blue
		"\033[38;5;25m",  // dark ocean
	}
	fmt.Printf("%s    ██████  ██████   ██████  █████ %s\n", g[0], reset)
	fmt.Printf("%s   ██    ██ ██   ██ ██      ██   ██%s\n", g[1], reset)
	fmt.Printf("%s   ██    ██ ██████  ██      ███████%s\n", g[2], reset)
	fmt.Printf("%s   ██    ██ ██   ██ ██      ██   ██%s\n", g[3], reset)
	fmt.Printf("%s    ██████  ██   ██  ██████ ██   ██%s\n", g[4], reset)
	fmt.Printf("        %smulti-agent orchestrator%s\n", g[4], reset)
	fmt.Println()
}

func useColor() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
