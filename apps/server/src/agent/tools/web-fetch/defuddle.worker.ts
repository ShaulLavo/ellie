/**
 * Fetch worker — manages headless Chrome via puppeteer-core and extracts
 * readable content from rendered pages using Defuddle + Turndown.
 *
 * Runs in a Web Worker to keep the main server thread free.
 * Chrome path detection adapted from @agent-infra/browser-finder.
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { Browser } from 'puppeteer-core'

puppeteer.use(StealthPlugin())
import { JSDOM } from 'jsdom'
import Defuddle from 'defuddle'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import * as Comlink from 'comlink'
import { existsSync } from 'fs'
import { join } from 'path'

// ── Chrome finder (adapted from @agent-infra/browser-finder) ────────────

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

// ── Browser singleton ──────────────────────────────────────────────────

const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let browserInstance: Browser | null = null
let browserLaunchPromise: Promise<Browser> | null = null

async function getBrowser(): Promise<Browser> {
	if (browserInstance?.connected) return browserInstance

	if (!browserLaunchPromise) {
		browserLaunchPromise = puppeteer
			.launch({
				executablePath: findChrome(),
				headless: true,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage'
				]
			})
			.then((browser: Browser) => {
				browserInstance = browser
				browserLaunchPromise = null

				browser.on('disconnected', () => {
					browserInstance = null
				})

				return browser
			})
			.catch((err: unknown) => {
				browserLaunchPromise = null
				throw err
			})
	}

	return browserLaunchPromise!
}

// ── Content extraction ──────────────────────────────────────────────────

const MIN_WORD_COUNT = 10

/** Sites where Defuddle consistently fails — skip straight to Readability. */
const READABILITY_ONLY_HOSTS: string[] = []

function shouldSkipDefuddle(url: string): boolean {
	if (READABILITY_ONLY_HOSTS.length === 0) return false
	try {
		const host = new URL(url).hostname.replace(/^www\./, '')
		return READABILITY_ONLY_HOSTS.some(
			h => host === h || host.endsWith('.' + h)
		)
	} catch {
		return false
	}
}

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-'
})

function parseWithDefuddle(html: string, url: string) {
	const dom = new JSDOM(html, { url })
	const defuddle = new Defuddle(dom.window.document, {
		url
	})
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

function parseWithReadability(html: string, url: string) {
	const dom = new JSDOM(html, { url })
	const article = new Readability(
		dom.window.document
	).parse()

	if (!article?.content) {
		return {
			title: dom.window.document.title || null,
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

function parseHtml(html: string, url: string) {
	if (shouldSkipDefuddle(url)) {
		return parseWithReadability(html, url)
	}
	const defuddled = parseWithDefuddle(html, url)
	if (defuddled.wordCount >= MIN_WORD_COUNT)
		return defuddled
	const readable = parseWithReadability(html, url)
	if (readable.wordCount > defuddled.wordCount)
		return readable
	return defuddled
}

// ── Worker API ─────────────────────────────────────────────────────────

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

	/** Parse pre-fetched HTML without a browser. */
	parse(html: string, url: string) {
		return parseHtml(html, url)
	},

	/** Close the browser if running. */
	async close() {
		if (browserInstance) {
			await browserInstance.close()
			browserInstance = null
		}
	}
}

export type FetchWorkerApi = typeof api

Comlink.expose(api)
