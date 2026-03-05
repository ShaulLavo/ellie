import { JSDOM } from 'jsdom'
import Defuddle from 'defuddle'
import TurndownService from 'turndown'
import * as Comlink from 'comlink'

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-'
})

const api = {
	parse(html: string, url: string) {
		const dom = new JSDOM(html, { url })
		const defuddle = new Defuddle(dom.window.document, { url })
		const result = defuddle.parse()

		const markdown = result.content
			? turndown.turndown(result.content)
			: ''

		return {
			title: result.title || null,
			author: result.author || null,
			wordCount: result.wordCount ?? 0,
			content: markdown
		}
	}
}

export type DefuddleWorkerApi = typeof api

Comlink.expose(api)
