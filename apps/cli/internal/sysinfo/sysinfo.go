package sysinfo

import "sync"

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
	KeyShell
	KeyTerminal
	KeyLocalIP
	KeyDisk
	KeyUptime
	KeyPackages
)

// Readout holds one piece of system information.
type Readout struct {
	Key   ReadoutKey
	Value string
	Err   error
}

// Info holds all collected readouts.
type Info struct {
	Readouts []Readout
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
