package sysinfo

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

// modelNames maps hw.model identifiers to friendly names.
// This avoids the slow system_profiler SPHardwareDataType call (~90ms).
var modelNames = map[string]string{
	"Mac14,2":   "MacBook Air",
	"Mac14,7":   "MacBook Pro",
	"Mac14,3":   "MacBook Pro",
	"Mac14,5":   "MacBook Pro",
	"Mac14,6":   "MacBook Pro",
	"Mac14,9":   "MacBook Pro",
	"Mac14,10":  "MacBook Pro",
	"Mac14,15":  "MacBook Air",
	"Mac15,3":   "MacBook Pro",
	"Mac15,6":   "MacBook Pro",
	"Mac15,7":   "MacBook Pro",
	"Mac15,8":   "MacBook Pro",
	"Mac15,9":   "MacBook Pro",
	"Mac15,10":  "MacBook Pro",
	"Mac15,11":  "MacBook Pro",
	"Mac15,12":  "MacBook Air",
	"Mac15,13":  "MacBook Air",
	"Mac14,8":   "Mac Pro",
	"Mac14,12":  "Mac mini",
	"Mac14,13":  "Mac Studio",
	"Mac14,14":  "Mac Studio",
	"Mac15,4":   "iMac",
	"Mac15,5":   "iMac",
	"Mac16,1":   "MacBook Pro",
	"Mac16,2":   "MacBook Pro",
	"Mac16,3":   "MacBook Air",
	"Mac16,5":   "MacBook Pro",
	"Mac16,6":   "MacBook Pro",
	"Mac16,7":   "MacBook Pro",
	"Mac16,8":   "MacBook Pro",
	"Mac16,10":  "Mac mini",
	"Mac16,11":  "Mac mini",
	"Mac16,12":  "iMac",
}

func fetchMachine() Readout {
	out, err := exec.Command("sysctl", "-n", "hw.model").Output()
	if err != nil {
		return Readout{Key: KeyMachine, Err: err}
	}
	model := strings.TrimSpace(string(out))

	if friendly, ok := modelNames[model]; ok {
		return Readout{Key: KeyMachine, Value: friendly, Percent: -1}
	}

	// Fallback: try to extract a name from the model ID pattern
	// e.g. "MacBookAir10,1" -> "MacBook Air"
	for _, prefix := range []struct{ id, name string }{
		{"MacBookAir", "MacBook Air"},
		{"MacBookPro", "MacBook Pro"},
		{"Macmini", "Mac mini"},
		{"MacPro", "Mac Pro"},
		{"iMac", "iMac"},
		{"MacStudio", "Mac Studio"},
	} {
		if strings.HasPrefix(model, prefix.id) {
			return Readout{Key: KeyMachine, Value: prefix.name, Percent: -1}
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
	// Use 0 duration for instant snapshot (avoids 200ms+ sleep).
	pcts, err := cpu.Percent(0, false)
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
