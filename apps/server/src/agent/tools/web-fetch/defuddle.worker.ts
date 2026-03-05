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

// ── Defuddle parser ────────────────────────────────────────────────────

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-'
})

function parseHtml(html: string, url: string) {
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
