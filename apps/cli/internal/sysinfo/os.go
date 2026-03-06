package sysinfo

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func fetchKernel() Readout {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return Readout{Key: KeyKernel, Err: err}
	}
	version := strings.TrimSpace(string(out))
	return Readout{Key: KeyKernel, Value: fmt.Sprintf("Darwin %s", version)}
}

func fetchOS() Readout {
	name, err := swVers("ProductName")
	if err != nil {
		return Readout{Key: KeyOS, Err: err}
	}
	ver, err := swVers("ProductVersion")
	if err != nil {
		return Readout{Key: KeyOS, Err: err}
	}
	return Readout{Key: KeyOS, Value: fmt.Sprintf("%s %s (%s)", name, ver, runtime.GOARCH)}
}

func fetchDistro() Readout {
	name, err := swVers("ProductName")
	if err != nil {
		return Readout{Key: KeyDistro, Err: err}
	}
	ver, err := swVers("ProductVersion")
	if err != nil {
		return Readout{Key: KeyDistro, Err: err}
	}
	build, err := swVers("BuildVersion")
	if err != nil {
		return Readout{Key: KeyDistro, Value: fmt.Sprintf("%s %s", name, ver)}
	}
	return Readout{Key: KeyDistro, Value: fmt.Sprintf("%s %s (%s)", name, ver, build)}
}

func fetchDE() Readout {
	return Readout{Key: KeyDE, Value: "Aqua"}
}

func fetchWM() Readout {
	return Readout{Key: KeyWM, Value: "Quartz Compositor"}
}

func fetchUptime() Readout {
	out, err := exec.Command("sysctl", "-n", "kern.boottime").Output()
	if err != nil {
		return Readout{Key: KeyUptime, Err: err}
	}
	// Output: "{ sec = 1709750400, usec = 0 } Thu Mar  6 ..."
	// Parse the sec value
	s := string(out)
	idx := strings.Index(s, "sec = ")
	if idx == -1 {
		return Readout{Key: KeyUptime, Err: fmt.Errorf("unexpected boottime format")}
	}
	s = s[idx+6:]
	end := strings.Index(s, ",")
	if end == -1 {
		return Readout{Key: KeyUptime, Err: fmt.Errorf("unexpected boottime format")}
	}
	var bootSec int64
	_, err = fmt.Sscanf(s[:end], "%d", &bootSec)
	if err != nil {
		return Readout{Key: KeyUptime, Err: err}
	}

	now := time.Now().Unix()
	uptimeSec := uint64(now - bootSec)
	return Readout{Key: KeyUptime, Value: FormatUptime(uptimeSec)}
}

// swVers runs sw_vers and returns the value for the given key.
func swVers(key string) (string, error) {
	out, err := exec.Command("sw_vers", "-"+key).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
