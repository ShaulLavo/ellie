package sysinfo

import "fmt"

// FormatUptime converts seconds to a human-readable duration.
// Examples: "2d 3h 15m", "45m", "3h 2m"
func FormatUptime(seconds uint64) string {
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	minutes := (seconds % 3600) / 60

	switch {
	case days > 0 && hours > 0 && minutes > 0:
		return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
	case days > 0 && hours > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case days > 0:
		return fmt.Sprintf("%dd", days)
	case hours > 0 && minutes > 0:
		return fmt.Sprintf("%dh %dm", hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh", hours)
	case minutes > 0:
		return fmt.Sprintf("%dm", minutes)
	default:
		return fmt.Sprintf("%ds", seconds)
	}
}

// FormatMemory formats bytes as "X.X GiB / Y.Y GiB (Z%)".
func FormatMemory(used, total uint64) string {
	const gib = 1024 * 1024 * 1024
	pct := float64(used) / float64(total) * 100
	return fmt.Sprintf("%.1f GiB / %.1f GiB (%.0f%%)",
		float64(used)/gib, float64(total)/gib, pct)
}

// FormatDisk formats disk usage as "X.X GB / Y.Y GB (Z%)".
func FormatDisk(used, total uint64) string {
	const gb = 1000 * 1000 * 1000
	pct := float64(used) / float64(total) * 100
	return fmt.Sprintf("%.0f GB / %.0f GB (%.0f%%)",
		float64(used)/gb, float64(total)/gb, pct)
}

// FormatBattery formats battery percentage and state.
func FormatBattery(pct int, state string) string {
	switch {
	case pct >= 100:
		return "Full"
	case state == "charging":
		return fmt.Sprintf("%d%% & Charging", pct)
	case state == "discharging":
		return fmt.Sprintf("%d%%", pct)
	case state == "charged":
		return "Full"
	default:
		return fmt.Sprintf("%d%% (%s)", pct, state)
	}
}
