package sysinfo

// LogoMacOSBig returns the big macOS Apple logo.
// Taken from Dylan Araps' Neofetch.
func LogoMacOSBig() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("                 ,MMMM.", ansiGreen),
		solidLine("               .MMMMMM", ansiGreen),
		solidLine("               MMMMM,", ansiGreen),
		solidLine("     .;MMMMM:' MMMMMMMMMM;.", ansiYellow),
		solidLine("   MMMMMMMMMMMMNWMMMMMMMMMMM:", ansiYellow),
		solidLine(" .MMMMMMMMMMMMMMMMMMMMMMMMWM.", ansiYellow),
		solidLine(" MMMMMMMMMMMMMMMMMMMMMMMMM.", ansiRed),
		solidLine(";MMMMMMMMMMMMMMMMMMMMMMMM:", ansiRed),
		solidLine(":MMMMMMMMMMMMMMMMMMMMMMMM:", ansiRed),
		solidLine(".MMMMMMMMMMMMMMMMMMMMMMMMM.", ansiMagenta),
		solidLine(" MMMMMMMMMMMMMMMMMMMMMMMMMMM.", ansiMagenta),
		solidLine("  .MMMMMMMMMMMMMMMMMMMMMMMMMM.", ansiMagenta),
		solidLine("    MMMMMMMMMMMMMMMMMMMMMMMM", ansiBlue),
		solidLine("     ;MMMMMMMMMMMMMMMMMMMM.", ansiBlue),
		solidLine("       .MMMM,.    .MMMM,.", ansiBlue),
	}}
}

// LogoMacOSSmall returns the small macOS Apple logo.
// Originally made by Joan Stark (jgs).
func LogoMacOSSmall() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("        .:'", ansiGreen),
		solidLine("    __ :'__", ansiGreen),
		solidLine(" .'`  `-'  ``.", ansiYellow),
		solidLine(":          .-'", ansiYellow),
		solidLine(":         :", ansiRed),
		solidLine(" :         `-;", ansiRed),
		solidLine("  `.__.-.__.'", ansiMagenta),
	}}
}
