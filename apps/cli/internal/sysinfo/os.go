package sysinfo

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// swVersData caches a single sw_vers call (used by OS and Distro).
var (
	swVersOnce   sync.Once
	swVersFields map[string]string
	swVersErr    error
)

func loadSwVers() (map[string]string, error) {
	swVersOnce.Do(func() {
		out, err := exec.Command("sw_vers").Output()
		if err != nil {
			swVersErr = err
			return
		}
		swVersFields = make(map[string]string)
		for _, line := range strings.Split(string(out), "\n") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				swVersFields[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
			}
		}
	})
	return swVersFields, swVersErr
}

func fetchKernel() Readout {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return Readout{Key: KeyKernel, Err: err}
	}
	version := strings.TrimSpace(string(out))
	return Readout{Key: KeyKernel, Value: fmt.Sprintf("Darwin %s", version)}
}

func fetchOS() Readout {
	fields, err := loadSwVers()
	if err != nil {
		return Readout{Key: KeyOS, Err: err}
	}
	name := fields["ProductName"]
	ver := fields["ProductVersion"]
	if name == "" || ver == "" {
		return Readout{Key: KeyOS, Err: fmt.Errorf("missing sw_vers fields")}
	}
	return Readout{Key: KeyOS, Value: fmt.Sprintf("%s %s (%s)", name, ver, runtime.GOARCH)}
}

func fetchDistro() Readout {
	fields, err := loadSwVers()
	if err != nil {
		return Readout{Key: KeyDistro, Err: err}
	}
	name := fields["ProductName"]
	ver := fields["ProductVersion"]
	build := fields["BuildVersion"]
	if name == "" || ver == "" {
		return Readout{Key: KeyDistro, Err: fmt.Errorf("missing sw_vers fields")}
	}
	if build != "" {
		return Readout{Key: KeyDistro, Value: fmt.Sprintf("%s %s (%s)", name, ver, build)}
	}
	return Readout{Key: KeyDistro, Value: fmt.Sprintf("%s %s", name, ver)}
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
