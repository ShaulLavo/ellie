// pty-bridge spawns a command in a pseudo-terminal and bridges
// its stdin/stdout to the PTY. This lets a parent process (like
// Bun.spawn) communicate with a TUI app that requires a real PTY.
//
// Protocol:
//   stdin:  0x00 + bytes → raw terminal input forwarded to PTY
//           0x01 + JSON  → resize command {"cols":N,"rows":N}
//   stdout: raw terminal output from the PTY
package main

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

type resizeMsg struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func main() {
	if len(os.Args) < 2 {
		os.Stderr.WriteString("usage: pty-bridge <command> [args...]\n")
		os.Exit(1)
	}

	cmd := exec.Command(os.Args[1], os.Args[2:]...)
	cmd.Env = os.Environ()

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		os.Stderr.WriteString("pty start failed: " + err.Error() + "\n")
		os.Exit(1)
	}
	defer ptmx.Close()

	// PTY stdout → our stdout
	go io.Copy(os.Stdout, ptmx)

	// Our stdin → PTY stdin (with resize protocol)
	buf := make([]byte, 32*1024)
	for {
		n, err := os.Stdin.Read(buf)
		if err != nil {
			break
		}
		if n == 0 {
			continue
		}

		data := buf[:n]
		switch data[0] {
		case 0x01: // resize
			var msg resizeMsg
			if json.Unmarshal(data[1:], &msg) == nil {
				pty.Setsize(ptmx, &pty.Winsize{Cols: msg.Cols, Rows: msg.Rows})
			}
		default: // raw input (0x00 prefix is stripped, bare bytes also work)
			if data[0] == 0x00 {
				data = data[1:]
			}
			ptmx.Write(data)
		}
	}

	cmd.Wait()
}
