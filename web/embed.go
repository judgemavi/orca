// Package web embeds the built frontend static files.
package web

import "embed"

//go:embed dist/*
var DistFS embed.FS
