package sysinfo

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

func fetchMachine() Readout {
	out, err := exec.Command("sysctl", "-n", "hw.model").Output()
	if err != nil {
		return Readout{Key: KeyMachine, Err: err}
	}
	model := strings.TrimSpace(string(out))

	// Try to get a friendlier name from system_profiler
	spOut, err := exec.Command("system_profiler", "SPHardwareDataType").Output()
	if err == nil {
		for _, line := range strings.Split(string(spOut), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Model Name:") {
				friendly := strings.TrimSpace(strings.TrimPrefix(line, "Model Name:"))
				if friendly != "" {
					return Readout{Key: KeyMachine, Value: friendly, Percent: -1}
				}
			}
		}
	}

	return Readout{Key: KeyMachine, Value: model, Percent: -1}
}

func fetchCPU() Readout {
	out, err := exec.Command("sysctl", "-n", "machdep.cpu.brand_string").Output()
	if err != nil {
		return Readout{Key: KeyCPU, Err: err}
	}
	brand := strings.TrimSpace(string(out))

	// Get core count
	coreOut, err := exec.Command("sysctl", "-n", "hw.logicalcpu").Output()
	if err == nil {
		cores := strings.TrimSpace(string(coreOut))
		return Readout{Key: KeyCPU, Value: fmt.Sprintf("%s (%s)", brand, cores), Percent: -1}
	}

	return Readout{Key: KeyCPU, Value: brand, Percent: -1}
}

func fetchCPULoad() Readout {
	pcts, err := cpu.Percent(200*time.Millisecond, false)
	if err != nil || len(pcts) == 0 {
		return Readout{Key: KeyCPULoad, Err: fmt.Errorf("cpu load: %w", err)}
	}
	return Readout{
		Key:     KeyCPULoad,
		Value:   fmt.Sprintf("%.1f%%", pcts[0]),
		Percent: pcts[0],
	}
}

func fetchMemory() Readout {
	v, err := mem.VirtualMemory()
	if err != nil {
		return Readout{Key: KeyMemory, Err: err}
	}
	return Readout{
		Key:     KeyMemory,
		Value:   FormatMemory(v.Used, v.Total),
		Percent: MemoryPercent(v.Used, v.Total),
	}
}

func fetchBattery() Readout {
	out, err := exec.Command("pmset", "-g", "batt").Output()
	if err != nil {
		return Readout{Key: KeyBattery, Err: err}
	}

	s := string(out)
	// Parse: "... 85%; charging; ..."
	re := regexp.MustCompile(`(\d+)%;\s*(\w[\w\s]*)`)
	matches := re.FindStringSubmatch(s)
	if len(matches) < 3 {
		// Maybe no battery (desktop Mac)
		return Readout{Key: KeyBattery, Err: fmt.Errorf("no battery found")}
	}

	pct, _ := strconv.Atoi(matches[1])
	state := strings.TrimSpace(matches[2])
	return Readout{Key: KeyBattery, Value: FormatBattery(pct, state), Percent: float64(pct)}
}

func fetchDisk() Readout {
	usage, err := disk.Usage("/")
	if err != nil {
		return Readout{Key: KeyDisk, Err: err}
	}
	return Readout{
		Key:     KeyDisk,
		Value:   FormatDisk(usage.Used, usage.Total),
		Percent: DiskPercent(usage.Used, usage.Total),
	}
}
