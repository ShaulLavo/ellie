package sysinfo

// LogoLinuxBig returns the big Linux Tux logo.
// Originally made by Joan Stark (jgs).
func LogoLinuxBig() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("       a8888b.", ansiWhite),
		solidLine("      d888888b.", ansiWhite),
		solidLine(`      8P"YP"Y88`, ansiWhite),
		solidLine("      8|o||o|88", ansiWhite),
		line(s("      8", ansiWhite), s("'    .", ansiYellow), s("88", ansiWhite)),
		line(s("      8", ansiWhite), s("`._.'", ansiYellow), s(" Y8.", ansiWhite)),
		solidLine("     d/      `8b.", ansiWhite),
		solidLine("    dP        Y8b.", ansiWhite),
		solidLine("   d8:       ::88b.", ansiWhite),
		solidLine(`  d8"         'Y88b`, ansiWhite),
		solidLine("  :8P           :888", ansiWhite),
		solidLine("  8a.         _a88P", ansiWhite),
		line(s(`._/"Y`, ansiYellow), s("aa     .", ansiWhite), s("|", ansiYellow), s(" 88P", ansiWhite), s("|", ansiYellow)),
		line(s(`\    Y`, ansiYellow), s(`P"    `, ansiWhite), s("`", ansiWhite), s("|     `.", ansiYellow)),
		line(s(`/     \`, ansiYellow), s(".___.d", ansiWhite), s("|    .'", ansiYellow)),
		solidLine("`--..__)     `._.'", ansiYellow),
	}}
}

// LogoLinuxSmall returns the small Linux Tux logo.
// Taken from asciiart.website.
func LogoLinuxSmall() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("    .--.", ansiWhite),
		line(s("   |o", ansiWhite), s("_", ansiYellow), s("o |", ansiWhite)),
		line(s("   |", ansiWhite), s(`\_/`, ansiYellow), s(" |", ansiWhite)),
		solidLine(`  //   \ \`, ansiWhite),
		solidLine(" (|     | )", ansiWhite),
		solidLine(`/'\_   _/'\`, ansiWhite),
		solidLine(`\___)=(___/`, ansiWhite),
	}}
}
