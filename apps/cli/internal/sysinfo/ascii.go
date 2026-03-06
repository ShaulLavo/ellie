package sysinfo

import (
	"embed"
	"strings"
)

//go:embed ascii/*
var asciiFS embed.FS

// Logo returns the Apple ASCII logo lines.
func Logo() []string {
	data, err := asciiFS.ReadFile("ascii/apple.txt")
	if err != nil {
		return nil
	}
	return strings.Split(string(data), "\n")
}
