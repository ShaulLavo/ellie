package chatui

import (
	"strings"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/ansi"
	"github.com/charmbracelet/x/exp/charmtone"
)

const maxMessageWidth = 120

// markdownRenderer returns a glamour TermRenderer configured with Ellie's
// style and the given word-wrap width.
func markdownRenderer(width int) *glamour.TermRenderer {
	r, _ := glamour.NewTermRenderer(
		glamour.WithStyles(markdownStyle()),
		glamour.WithWordWrap(width),
	)
	return r
}

// renderMarkdown renders content as terminal-formatted markdown via glamour.
// Falls back to simple word wrapping on error.
func renderMarkdown(content string, width int) string {
	renderer := markdownRenderer(width)
	result, err := renderer.Render(content)
	if err != nil {
		return wrapText(content, width)
	}
	return strings.TrimSuffix(result, "\n")
}

func sp(s string) *string { return &s }
func bp(b bool) *bool     { return &b }
func up(u uint) *uint     { return &u }

// hex returns the hex string for a charmtone color key.
func hex(k charmtone.Key) *string { s := k.Hex(); return &s }

// markdownStyle returns an ansi.StyleConfig using charmtone colors mapped
// to Ellie's teal-centric palette.
//
//	Guac     → teal primary (headings, functions, attributes)
//	Julep    → bright teal (inline code, builtins, escapes, types)
//	Anchovy  → blue (keywords, links, tags)
//	Orchid   → purple (decorators, namespaces, preprocessor)
//	Cumin    → warm gold (strings, numbers)
//	Bengal   → coral-red (errors, deletions)
//	Salt     → near-white (document text, names)
//	Squid    → medium gray (comments, image text, subheadings)
//	Oyster   → dim gray (rules, operators, punctuation)
//	Pepper   → dark bg (code blocks, H1 background)
func markdownStyle() ansi.StyleConfig {
	return ansi.StyleConfig{
		Document: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Color: hex(charmtone.Salt),
			},
		},
		BlockQuote: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{},
			Indent:         up(1),
			IndentToken:    sp("│ "),
		},
		List: ansi.StyleList{
			LevelIndent: 2,
		},
		Heading: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				BlockSuffix: "\n",
				Color:       hex(charmtone.Guac),
				Bold:        bp(true),
			},
		},
		H1: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix:          " ",
				Suffix:          " ",
				Color:           hex(charmtone.Guac),
				BackgroundColor: hex(charmtone.Pepper),
				Bold:            bp(true),
			},
		},
		H2: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "## ",
			},
		},
		H3: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "### ",
			},
		},
		H4: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "#### ",
			},
		},
		H5: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "##### ",
			},
		},
		H6: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix: "###### ",
				Color:  hex(charmtone.Julep),
				Bold:   bp(false),
			},
		},
		Strikethrough: ansi.StylePrimitive{
			CrossedOut: bp(true),
		},
		Emph: ansi.StylePrimitive{
			Italic: bp(true),
		},
		Strong: ansi.StylePrimitive{
			Bold: bp(true),
		},
		HorizontalRule: ansi.StylePrimitive{
			Color:  hex(charmtone.Oyster),
			Format: "\n--------\n",
		},
		Item: ansi.StylePrimitive{
			BlockPrefix: "• ",
		},
		Enumeration: ansi.StylePrimitive{
			BlockPrefix: ". ",
		},
		Task: ansi.StyleTask{
			StylePrimitive: ansi.StylePrimitive{},
			Ticked:         "[✓] ",
			Unticked:       "[ ] ",
		},
		Link: ansi.StylePrimitive{
			Color:     hex(charmtone.Anchovy),
			Underline: bp(true),
		},
		LinkText: ansi.StylePrimitive{
			Color: hex(charmtone.Anchovy),
			Bold:  bp(true),
		},
		Image: ansi.StylePrimitive{
			Color:     hex(charmtone.Orchid),
			Underline: bp(true),
		},
		ImageText: ansi.StylePrimitive{
			Color:  hex(charmtone.Squid),
			Format: "Image: {{.text}} →",
		},
		Code: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix:          " ",
				Suffix:          " ",
				Color:           hex(charmtone.Julep),
				BackgroundColor: hex(charmtone.Pepper),
			},
		},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{
					Color: hex(charmtone.Oyster),
				},
				Margin: up(2),
			},
			Chroma: &ansi.Chroma{
				Text: ansi.StylePrimitive{
					Color: hex(charmtone.Salt),
				},
				Error: ansi.StylePrimitive{
					Color:           hex(charmtone.Zest),
					BackgroundColor: hex(charmtone.Bengal),
				},
				Comment: ansi.StylePrimitive{
					Color: hex(charmtone.Squid),
				},
				CommentPreproc: ansi.StylePrimitive{
					Color: hex(charmtone.Orchid),
				},
				Keyword: ansi.StylePrimitive{
					Color: hex(charmtone.Anchovy),
				},
				KeywordReserved: ansi.StylePrimitive{
					Color: hex(charmtone.Orchid),
				},
				KeywordNamespace: ansi.StylePrimitive{
					Color: hex(charmtone.Orchid),
				},
				KeywordType: ansi.StylePrimitive{
					Color: hex(charmtone.Julep),
				},
				Operator: ansi.StylePrimitive{
					Color: hex(charmtone.Oyster),
				},
				Punctuation: ansi.StylePrimitive{
					Color: hex(charmtone.Oyster),
				},
				Name: ansi.StylePrimitive{
					Color: hex(charmtone.Salt),
				},
				NameBuiltin: ansi.StylePrimitive{
					Color: hex(charmtone.Julep),
				},
				NameTag: ansi.StylePrimitive{
					Color: hex(charmtone.Anchovy),
				},
				NameAttribute: ansi.StylePrimitive{
					Color: hex(charmtone.Guac),
				},
				NameClass: ansi.StylePrimitive{
					Color:     hex(charmtone.Salt),
					Underline: bp(true),
					Bold:      bp(true),
				},
				NameDecorator: ansi.StylePrimitive{
					Color: hex(charmtone.Orchid),
				},
				NameFunction: ansi.StylePrimitive{
					Color: hex(charmtone.Guac),
				},
				LiteralNumber: ansi.StylePrimitive{
					Color: hex(charmtone.Cumin),
				},
				LiteralString: ansi.StylePrimitive{
					Color: hex(charmtone.Cumin),
				},
				LiteralStringEscape: ansi.StylePrimitive{
					Color: hex(charmtone.Julep),
				},
				GenericDeleted: ansi.StylePrimitive{
					Color: hex(charmtone.Bengal),
				},
				GenericEmph: ansi.StylePrimitive{
					Italic: bp(true),
				},
				GenericInserted: ansi.StylePrimitive{
					Color: hex(charmtone.Guac),
				},
				GenericStrong: ansi.StylePrimitive{
					Bold: bp(true),
				},
				GenericSubheading: ansi.StylePrimitive{
					Color: hex(charmtone.Squid),
				},
				Background: ansi.StylePrimitive{
					BackgroundColor: hex(charmtone.Pepper),
				},
			},
		},
		Table: ansi.StyleTable{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{},
			},
		},
		DefinitionDescription: ansi.StylePrimitive{
			BlockPrefix: "\n ",
		},
	}
}
