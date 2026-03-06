package sysinfo

// LogoWindowsBig returns the big Windows logo.
func LogoWindowsBig() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine(" ", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
		solidLine("WWWWWWWWWWWWWW  WWWWWWWWWWWWWW", ansiBlue),
	}}
}

// LogoWindowsSmall returns the small Windows logo.
func LogoWindowsSmall() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("wwww  wwww", ansiBlue),
		solidLine("wwww  wwww", ansiBlue),
		solidLine("wwww  wwww", ansiBlue),
		solidLine(" ", ansiBlue),
		solidLine("wwww  wwww", ansiBlue),
		solidLine("wwww  wwww", ansiBlue),
		solidLine("wwww  wwww", ansiBlue),
	}}
}
