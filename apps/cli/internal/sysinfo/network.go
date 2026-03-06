package sysinfo

import (
	"fmt"
	"net"
)

func fetchLocalIP() Readout {
	ifaces, err := net.Interfaces()
	if err != nil {
		return Readout{Key: KeyLocalIP, Err: err}
	}

	for _, iface := range ifaces {
		// Skip loopback, down, and virtual interfaces
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP
			if ip.To4() != nil && !ip.IsLoopback() {
				return Readout{Key: KeyLocalIP, Value: fmt.Sprintf("%s (%s)", ip.String(), iface.Name)}
			}
		}
	}

	return Readout{Key: KeyLocalIP, Err: fmt.Errorf("no IPv4 address found")}
}
