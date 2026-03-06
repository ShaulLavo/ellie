package sysinfo

// LogoFreeBSD returns the FreeBSD logo (small only).
// Taken from Dylan Araps' pfetch.
func LogoFreeBSD() Logo {
	return Logo{Lines: []LogoLine{
		solidLine(`/\,-'''''-,/\`, ansiRed),
		solidLine(`\_)       (_//`, ansiRed),
		solidLine(" |           |", ansiRed),
		solidLine(" |           |", ansiRed),
		solidLine("  ;         ;", ansiRed),
		solidLine("   '-_____-'", ansiRed),
	}}
}

// LogoNetBSDBig returns the big NetBSD logo.
func LogoNetBSDBig() Logo {
	return Logo{Lines: []LogoLine{
		line(s(`\\`, ansiWhite), s("`-______,----__", ansiYellow)),
		line(s(` \\`, ansiWhite), s("        __,---`.", ansiYellow)),
		line(s(`  \\`, ansiWhite), s("       `.____", ansiYellow)),
		line(s(`   \\`, ansiWhite), s("-______,----`.", ansiYellow)),
		solidLine(`    \\`, ansiWhite),
		solidLine(`     \\`, ansiWhite),
		solidLine(`      \\`, ansiWhite),
		solidLine(`       \\`, ansiWhite),
		solidLine(`        \\`, ansiWhite),
		solidLine(`         \\`, ansiWhite),
		solidLine(`          \\`, ansiWhite),
	}}
}

// LogoNetBSDSmall returns the small NetBSD logo.
func LogoNetBSDSmall() Logo {
	return Logo{Lines: []LogoLine{
		line(s("()", ansiBlack), s("ncncncncncnc", ansiYellow)),
		line(s(` \\`, ansiBlack), s("ncncncnc", ansiYellow)),
		line(s(`  \\`, ansiBlack), s("ncncncncncn", ansiYellow)),
		solidLine(`   \\`, ansiBlack),
		solidLine(`    \\`, ansiBlack),
		solidLine(`     \\`, ansiBlack),
	}}
}
