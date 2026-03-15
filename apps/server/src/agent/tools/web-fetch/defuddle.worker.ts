/**
 * Fetch worker — manages headless Chrome via puppeteer-core and extracts
 * readable content from rendered pages using Defuddle.
 *
 * Runs in a Web Worker to keep the main server thread free.
 * Chrome path detection adapted from @agent-infra/browser-finder.
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { Browser } from 'puppeteer-core'

import { Defuddle } from 'defuddle/node'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import * as Comlink from 'comlink'
import {
	existsSync,
	readFileSync,
	writeFileSync,
	unlinkSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

puppeteer.use(StealthPlugin())

const PID_FILE = join(tmpdir(), 'ellie-browser.pid')

/** Kill an orphaned browser process from a previous run. */
function killOrphanedBrowser(): void {
	try {
		if (!existsSync(PID_FILE)) return
		const pid = parseInt(
			readFileSync(PID_FILE, 'utf8').trim(),
			10
		)
		if (isNaN(pid)) {
			unlinkSync(PID_FILE)
			return
		}
		// Check if the process is still alive
		try {
			process.kill(pid, 0) // signal 0 = existence check
			console.log(
				`[web-fetch] killing orphaned browser (pid ${pid})`
			)
			process.kill(pid, 'SIGKILL')
		} catch {
			// Process already dead — clean up stale PID file
		}
		unlinkSync(PID_FILE)
	} catch {
		// PID file read/delete failed — ignore
	}
}

function writePidFile(pid: number): void {
	try {
		writeFileSync(PID_FILE, String(pid), 'utf8')
	} catch {
		// Non-critical — orphan cleanup just won't work next time
	}
}

function removePidFile(): void {
	try {
		if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
	} catch {
		// ignore
	}
}

function findChromeOnDarwin(): string | null {
	// Standard Chrome installations
	const chromeNames = [
		'Google Chrome',
		'Google Chrome Beta',
		'Google Chrome Dev',
		'Google Chrome Canary'
	] as const
	for (const name of chromeNames) {
		for (const prefix of ['', process.env.HOME ?? '']) {
			const p = join(
				prefix,
				`/Applications/${name}.app/Contents/MacOS/${name}`
			)
			if (existsSync(p)) return p
		}
	}

	// Other Chromium-based browsers
	const chromiumApps = [
		'Helium',
		'Chromium',
		'Brave Browser',
		'Microsoft Edge'
	] as const
	for (const name of chromiumApps) {
		for (const prefix of ['', process.env.HOME ?? '']) {
			const p = join(
				prefix,
				`/Applications/${name}.app/Contents/MacOS/${name}`
			)
			if (existsSync(p)) return p
		}
	}

	return null
}

function findChromeOnLinux(): string | null {
	const names = [
		'google-chrome-stable',
		'google-chrome',
		'google-chrome-beta',
		'google-chrome-dev',
		'chromium-browser',
		'chromium'
	] as const
	for (const name of names) {
		const p = Bun.which(name)
		if (p) return p
	}
	return null
}

function findChromeOnWindows(): string | null {
	const names = [
		'Chrome',
		'Chrome Beta',
		'Chrome Dev',
		'Chrome SxS'
	] as const
	const prefixes = [
		process.env.LOCALAPPDATA,
		process.env.PROGRAMFILES,
		process.env['PROGRAMFILES(X86)']
	].filter(Boolean) as string[]
	for (const name of names) {
		for (const prefix of prefixes) {
			const p = join(
				prefix,
				'Google',
				name,
				'Application',
				'chrome.exe'
			)
			if (existsSync(p)) return p
		}
	}
	return null
}

function findChrome(): string {
	const finders: Record<string, () => string | null> = {
		darwin: findChromeOnDarwin,
		linux: findChromeOnLinux,
		win32: findChromeOnWindows
	}
	const finder = finders[process.platform]
	if (!finder) {
		throw new Error(
			`Unsupported platform: ${process.platform}`
		)
	}
	const path = finder()
	if (!path) {
		throw new Error(
			`Unable to find Chrome on ${process.platform}. Install Google Chrome to use web fetching.`
		)
	}
	return path
}

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let browserInstance: Browser | null = null
let browserLaunchPromise: Promise<Browser> | null = null

async function launchBrowser(): Promise<Browser> {
	try {
		const browser = await puppeteer.launch({
			executablePath: findChrome(),
			headless: true,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage'
			]
		})

		browserInstance = browser
		browserLaunchPromise = null

		const proc = browser.process()
		if (proc?.pid) {
			writePidFile(proc.pid)
		}

		browser.on('disconnected', () => {
			browserInstance = null
			removePidFile()
		})

		return browser
	} catch (err) {
		browserLaunchPromise = null
		throw err
	}
}

function getBrowser(): Promise<Browser> {
	if (browserInstance?.connected)
		return Promise.resolve(browserInstance)

	if (!browserLaunchPromise) {
		killOrphanedBrowser()
		browserLaunchPromise = launchBrowser()
	}

	return browserLaunchPromise
}

const MAX_DEFUDDLE_CHARS = 2_000_000 // 2 MB — Defuddle handles well
const MAX_READABILITY_CHARS = 20_000_000 // 20 MB — Readability handles well
const MAX_NESTING_DEPTH = 3_000

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
])

/**
 * Cheap heuristic to detect pathologically nested HTML that could
 * blow up the stack in Defuddle/Readability/linkedom.
 * Not a parser — tuned to catch attacker-controlled "<div><div>..." cases.
 */
function exceedsNestingDepth(
	html: string,
	maxDepth: number
): boolean {
	let depth = 0
	const len = html.length
	for (let i = 0; i < len; i++) {
		if (html.charCodeAt(i) !== 60) continue // '<'
		const next = html.charCodeAt(i + 1)
		if (next === 33 || next === 63) continue // <! or <?

		const closing = next === 47 // '/'
		const nameStart = closing ? i + 2 : i + 1

		let j = nameStart
		while (
			j < len &&
			html.charCodeAt(j) !== 32 &&
			html.charCodeAt(j) !== 62 &&
			html.charCodeAt(j) !== 47 &&
			html.charCodeAt(j) !== 10 &&
			html.charCodeAt(j) !== 13
		) {
			j++
		}

		const tagName = html.slice(nameStart, j).toLowerCase()
		if (!tagName) continue

		if (closing) {
			depth = Math.max(0, depth - 1)
			continue
		}
		if (VOID_TAGS.has(tagName)) continue

		// Best-effort self-closing detection
		let selfClosing = false
		for (let k = j; k < len && k < j + 200; k++) {
			if (html.charCodeAt(k) === 62) {
				if (html.charCodeAt(k - 1) === 47)
					selfClosing = true
				break
			}
		}
		if (selfClosing) continue

		depth++
		if (depth > maxDepth) return true
	}
	return false
}

/**
 * Strip HTML to plain text — fallback for pathological HTML
 * that's too large or deeply nested for DOM parsing.
 */
function stripHtmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim()
}

const MIN_WORD_COUNT = 10

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-'
})

function parseWithReadability(html: string, _url: string) {
	const { document } = parseHTML(html)
	const article = new Readability(
		document as unknown as Document
	).parse()

	if (!article?.content) {
		return {
			title: document.title || null,
			author: null,
			wordCount: 0,
			content: ''
		}
	}

	const markdown = turndown.turndown(article.content)
	const wordCount = markdown
		.split(/\s+/)
		.filter(Boolean).length

	return {
		title: article.title || null,
		author: article.byline || null,
		wordCount,
		content: markdown
	}
}

async function parseHtml(html: string, url: string) {
	const tooDeep = exceedsNestingDepth(
		html,
		MAX_NESTING_DEPTH
	)

	// Beyond all DOM parser limits — strip tags
	if (html.length > MAX_READABILITY_CHARS || tooDeep) {
		const text = stripHtmlToText(html)
		return {
			title: null,
			author: null,
			wordCount: text.split(/\s+/).filter(Boolean).length,
			content: text
		}
	}

	// Within Defuddle's range — try it first
	if (html.length <= MAX_DEFUDDLE_CHARS) {
		const defuddled = await Defuddle(html, url, {
			markdown: true
		})
		const defuddleResult = {
			title: defuddled.title || null,
			author: defuddled.author || null,
			wordCount: defuddled.wordCount ?? 0,
			content: defuddled.content || ''
		}

		if (defuddleResult.wordCount >= MIN_WORD_COUNT)
			return defuddleResult

		// Defuddle scored poorly — fall through to Readability
	}

	// 2–20 MB or Defuddle fallback — Readability only
	return parseWithReadability(html, url)
}

const api = {
	/** Navigate to URL with headless Chrome, extract readable content. */
	async fetchPage(url: string) {
		const browser = await getBrowser()
		const page = await browser.newPage()

		try {
			await page.setUserAgent(USER_AGENT)
			await page.goto(url, {
				waitUntil: 'networkidle2',
				timeout: 30_000
			})
			const html = await page.content()
			return parseHtml(html, url)
		} finally {
			await page.close()
		}
	},

	/** Close the browser if running. */
	async close() {
		if (browserInstance) {
			await browserInstance.close()
			browserInstance = null
			removePidFile()
		}
	}
}

export type FetchWorkerApi = typeof api

Comlink.expose(api)
