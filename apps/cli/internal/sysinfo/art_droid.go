package sysinfo

// LogoAndroidBig returns the big Android logo.
func LogoAndroidBig() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("    .        .", ansiGreen),
		solidLine(`     \      /`, ansiGreen),
		solidLine("    .oooooooo.", ansiGreen),
		solidLine("   .oooooooooo. ", ansiGreen),
		solidLine("   ooo  oo  ooo", ansiGreen),
		solidLine("   oooooooooooo", ansiGreen),
		solidLine("   ____________", ansiGreen),
		solidLine("oo oooooooooooo oo", ansiGreen),
		solidLine("oo oooooooooooo oo", ansiGreen),
		solidLine("oo oooooooooooo oo", ansiGreen),
		solidLine("   oooooooooooo", ansiGreen),
		solidLine("     ooo   ooo", ansiGreen),
		solidLine("     ooo   ooo", ansiGreen),
	}}
}

// LogoAndroidSmall returns the small Android logo.
func LogoAndroidSmall() Logo {
	return Logo{Lines: []LogoLine{
		solidLine("  .        .   ", ansiGreen),
		solidLine(`   \      /   `, ansiGreen),
		solidLine("  .oooooooo.   ", ansiGreen),
		solidLine(" .oooooooooo.  ", ansiGreen),
		solidLine(" ooo  oo  ooo  ", ansiGreen),
		solidLine(" oooooooooooo  ", ansiGreen),
	}}
}
