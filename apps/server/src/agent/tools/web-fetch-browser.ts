/**
 * Playwright browser lifecycle — lazy launch, singleton reuse, process cleanup.
 *
 * Uses playwright-extra with stealth plugin for anti-detection.
 * Mirrors the tei.ts pattern: module-level state with SIGINT/SIGTERM handlers.
 */

import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { Browser } from 'playwright-core'

chromium.use(StealthPlugin())

let browserInstance: Browser | null = null
let browserLaunchPromise: Promise<Browser> | null = null

/**
 * Get or launch the shared browser instance.
 * Lazy — first call launches chromium, subsequent calls reuse it.
 * Concurrent-safe — callers share the same launch promise.
 */
export async function getBrowser(): Promise<Browser> {
	if (browserInstance?.isConnected()) return browserInstance

	if (!browserLaunchPromise) {
		browserLaunchPromise = chromium
			.launch({
				headless: true,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage'
				]
			})
			.then(browser => {
				browserInstance = browser
				browserLaunchPromise = null

				browser.on('disconnected', () => {
					browserInstance = null
				})

				return browser
			})
			.catch(err => {
				browserLaunchPromise = null
				throw err
			})
	}

	return browserLaunchPromise
}

/** Close the browser if running. Called on server shutdown. */
export async function closeBrowser(): Promise<void> {
	if (browserInstance) {
		await browserInstance.close()
		browserInstance = null
	}
}

// Ensure cleanup on exit
process.on('SIGINT', () => {
	closeBrowser().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
	closeBrowser().finally(() => process.exit(0))
})
