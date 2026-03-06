package sysinfo

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

func fetchGPU() Readout {
	// Use ioreg instead of system_profiler (~15ms vs ~240ms).
	out, err := exec.Command("ioreg", "-r", "-c", "AGXAccelerator", "-d", "1").Output()
	if err != nil {
		return Readout{Key: KeyGPU, Err: err}
	}
	s := string(out)

	model := ioregValue(s, `"model"`)
	cores := ioregValue(s, `"gpu-core-count"`)

	if model == "" {
		return Readout{Key: KeyGPU, Err: fmt.Errorf("no GPU found")}
	}
	if cores != "" {
		return Readout{Key: KeyGPU, Value: fmt.Sprintf("%s (%s cores)", model, cores), Percent: -1}
	}
	return Readout{Key: KeyGPU, Value: model, Percent: -1}
}

func fetchResolution() Readout {
	// Use ioreg instead of system_profiler (~14ms vs ~240ms).
	// Parse HorizontalAttributes Active and VerticalAttributes Active from IOMobileFramebuffer.
	out, err := exec.Command("ioreg", "-r", "-c", "IOMobileFramebuffer", "-d", "1").Output()
	if err != nil {
		return Readout{Key: KeyResolution, Err: err}
	}

	// Match: "HorizontalAttributes"={"Total"=...,"Active"=2560,...}
	// and "VerticalAttributes"={"Total"=...,"Active"=1600,...}
	// Only grab from the first PreferredTimingElements block.
	s := string(out)
	hRe := regexp.MustCompile(`HorizontalAttributes.*?"Active"=(\d+)`)
	vRe := regexp.MustCompile(`VerticalAttributes.*?"Active"=(\d+)`)

	hMatch := hRe.FindStringSubmatch(s)
	vMatch := vRe.FindStringSubmatch(s)
	if len(hMatch) < 2 || len(vMatch) < 2 {
		return Readout{Key: KeyResolution, Err: fmt.Errorf("no display resolution found")}
	}

	w, _ := strconv.Atoi(hMatch[1])
	h, _ := strconv.Atoi(vMatch[1])
	return Readout{Key: KeyResolution, Value: fmt.Sprintf("%d x %d", w, h), Percent: -1}
}

// ioregValue extracts a value like "model" = "Apple M1" or "gpu-core-count" = 8.
func ioregValue(s, key string) string {
	idx := strings.Index(s, key+" = ")
	if idx == -1 {
		return ""
	}
	rest := s[idx+len(key)+3:]
	// String value: "Apple M1"
	if strings.HasPrefix(rest, "\"") {
		end := strings.Index(rest[1:], "\"")
		if end == -1 {
			return ""
		}
		return rest[1 : end+1]
	}
	// Numeric value: 8
	end := strings.IndexAny(rest, "\n ,}")
	if end == -1 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:end])
}
