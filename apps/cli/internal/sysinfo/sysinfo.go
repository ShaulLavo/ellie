package sysinfo

import (
	"encoding/json"
	"strings"
	"sync"
)

// ReadoutKey identifies a piece of system information.
type ReadoutKey int

const (
	KeyHost ReadoutKey = iota
	KeyMachine
	KeyKernel
	KeyOS
	KeyDistro
	KeyDE
	KeyWM
	KeyCPU
	KeyCPULoad
	KeyMemory
	KeyBattery
	KeyGPU
	KeyResolution
	KeyShell
	KeyTerminal
	KeyLocalIP
	KeyDisk
	KeyUptime
	KeyPackages
)

// KeyNames maps ReadoutKey to its short name (used by --show flag).
var KeyNames = map[string]ReadoutKey{
	"host":       KeyHost,
	"machine":    KeyMachine,
	"kernel":     KeyKernel,
	"os":         KeyOS,
	"distro":     KeyDistro,
	"de":         KeyDE,
	"wm":         KeyWM,
	"cpu":        KeyCPU,
	"cpu_load":   KeyCPULoad,
	"memory":     KeyMemory,
	"battery":    KeyBattery,
	"gpu":        KeyGPU,
	"resolution": KeyResolution,
	"shell":      KeyShell,
	"terminal":   KeyTerminal,
	"local_ip":   KeyLocalIP,
	"disk":       KeyDisk,
	"uptime":     KeyUptime,
	"packages":   KeyPackages,
}

// AllKeyNames returns all valid key names sorted by display order.
func AllKeyNames() []string {
	return []string{
		"host", "machine", "kernel", "os", "distro", "de", "wm",
		"cpu", "cpu_load", "memory", "battery", "gpu", "resolution",
		"shell", "terminal", "local_ip", "disk", "uptime", "packages",
	}
}

// Readout holds one piece of system information.
type Readout struct {
	Key     ReadoutKey
	Value   string
	Percent float64 // -1 if not applicable, 0-100 for bar-capable readouts
	Err     error
}

// Info holds all collected readouts.
type Info struct {
	Readouts []Readout
}

// Filter returns a new Info with only the specified keys.
func (info Info) Filter(keys []ReadoutKey) Info {
	set := make(map[ReadoutKey]bool, len(keys))
	for _, k := range keys {
		set[k] = true
	}
	var filtered []Readout
	for _, r := range info.Readouts {
		if set[r.Key] {
			filtered = append(filtered, r)
		}
	}
	return Info{Readouts: filtered}
}

// ToJSON returns the info as a JSON string.
func (info Info) ToJSON() (string, error) {
	m := make(map[string]string)
	// Build reverse map for key names
	nameByKey := make(map[ReadoutKey]string)
	for name, key := range KeyNames {
		nameByKey[key] = name
	}
	for _, r := range info.Readouts {
		if r.Err != nil {
			continue
		}
		name := nameByKey[r.Key]
		if name != "" {
			m[name] = r.Value
		}
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ParseShowKeys parses a comma-separated list of key names into ReadoutKeys.
func ParseShowKeys(show string) ([]ReadoutKey, error) {
	parts := strings.Split(show, ",")
	var keys []ReadoutKey
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		key, ok := KeyNames[p]
		if !ok {
			return nil, &UnknownKeyError{Name: p}
		}
		keys = append(keys, key)
	}
	return keys, nil
}

// UnknownKeyError is returned when an invalid readout key name is used.
type UnknownKeyError struct {
	Name string
}

func (e *UnknownKeyError) Error() string {
	return "unknown readout key: " + e.Name + "\nvalid keys: " + strings.Join(AllKeyNames(), ", ")
}

// Collect gathers all system readouts concurrently.
func Collect() Info {
	fetchers := []func() Readout{
		fetchHost,
		fetchMachine,
		fetchKernel,
		fetchOS,
		fetchDistro,
		fetchDE,
		fetchWM,
		fetchCPU,
		fetchCPULoad,
		fetchMemory,
		fetchBattery,
		fetchGPU,
		fetchResolution,
		fetchShell,
		fetchTerminal,
		fetchLocalIP,
		fetchDisk,
		fetchUptime,
		fetchPackages,
	}

	results := make([]Readout, len(fetchers))
	var wg sync.WaitGroup
	for i, fn := range fetchers {
		wg.Add(1)
		go func(idx int, f func() Readout) {
			defer wg.Done()
			results[idx] = f()
		}(i, fn)
	}
	wg.Wait()

	return Info{Readouts: results}
}
