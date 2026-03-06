package sysinfo

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// spDisplayData holds parsed system_profiler SPDisplaysDataType JSON.
type spDisplayData struct {
	SPDisplaysDataType []spGPU `json:"SPDisplaysDataType"`
}

type spGPU struct {
	Name     string      `json:"_name"`
	Model    string      `json:"sppci_model"`
	Cores    string      `json:"sppci_cores"`
	Vendor   string      `json:"spdisplays_vendor"`
	Displays []spDisplay `json:"spdisplays_ndrvs"`
}

type spDisplay struct {
	Name       string `json:"_name"`
	Pixels     string `json:"_spdisplays_pixels"`
	Resolution string `json:"_spdisplays_resolution"`
	PixelRes   string `json:"spdisplays_pixelresolution"`
}

// cachedDisplayData caches the system_profiler call since both GPU and Resolution use it.
var cachedDisplayData *spDisplayData

func getDisplayData() (*spDisplayData, error) {
	if cachedDisplayData != nil {
		return cachedDisplayData, nil
	}
	out, err := exec.Command("system_profiler", "SPDisplaysDataType", "-json").Output()
	if err != nil {
		return nil, err
	}
	var data spDisplayData
	if err := json.Unmarshal(out, &data); err != nil {
		return nil, err
	}
	cachedDisplayData = &data
	return &data, nil
}

func fetchGPU() Readout {
	data, err := getDisplayData()
	if err != nil {
		return Readout{Key: KeyGPU, Err: err}
	}
	if len(data.SPDisplaysDataType) == 0 {
		return Readout{Key: KeyGPU, Err: fmt.Errorf("no GPU found")}
	}

	gpu := data.SPDisplaysDataType[0]
	model := gpu.Model
	if model == "" {
		model = gpu.Name
	}

	if gpu.Cores != "" {
		return Readout{Key: KeyGPU, Value: fmt.Sprintf("%s (%s cores)", model, gpu.Cores)}
	}
	return Readout{Key: KeyGPU, Value: model}
}

func fetchResolution() Readout {
	data, err := getDisplayData()
	if err != nil {
		return Readout{Key: KeyResolution, Err: err}
	}

	var resolutions []string
	for _, gpu := range data.SPDisplaysDataType {
		for _, disp := range gpu.Displays {
			// Prefer the native pixel resolution
			res := disp.Pixels
			if res == "" {
				res = disp.Resolution
			}
			if res == "" {
				continue
			}
			// Clean up and add display name
			res = strings.TrimSpace(res)
			if disp.Name != "" {
				res = fmt.Sprintf("%s (%s)", res, disp.Name)
			}
			resolutions = append(resolutions, res)
		}
	}

	if len(resolutions) == 0 {
		return Readout{Key: KeyResolution, Err: fmt.Errorf("no displays found")}
	}

	return Readout{Key: KeyResolution, Value: strings.Join(resolutions, ", ")}
}
