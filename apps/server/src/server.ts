import { createHindsightApp } from '@ellie/hindsight/server'
import {
	createRootScope,
	createChildScope
} from '@ellie/trace'
import { createTusApp } from '@ellie/tus'
import { openapi } from '@elysiajs/openapi'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { staticPlugin } from '@elysiajs/static'
import { tryValibotSummary } from '@ellie/schemas'
import { toJsonSchema } from '@valibot/to-json-schema'
import { Elysia } from 'elysia'
import { createAgentRoutes } from './routes/agent'
import {
	createAuthRoutes,
	createGroqAuthRoutes,
	createBraveAuthRoutes,
	createElevenLabsAuthRoutes,
	createCivitaiAuthRoutes
} from './routes/auth'
import { createChatRoutes } from './routes/chat'
import { errorSchema } from './routes/schemas/common-schemas'
import { HttpError } from './routes/http-errors'
import { createSessionRoutes } from './routes/session'
import { createStatusRoutes } from './routes/status'
import { createDbStudioRoutes } from './routes/db-studio'
import { createDevRoutes } from './routes/dev'
import { createTerminalRoutes } from './routes/terminal'
import { createSpeechRoutes } from './routes/speech'
import { createTtsRoutes } from './routes/tts'
import { createTraceRoutes } from './routes/traces'
import { createChannelRoutes } from './routes/channels'
import { API_INFO, API_TAGS } from './consts'
import { init } from './init'
import { getTrailingSlashRedirectUrl } from './lib/trailing-slash'

const ctx = await init()

export const app = new Elysia()
	.onRequest(({ request }) => {
		const redirectUrl = getTrailingSlashRedirectUrl(
			request.url
		)
		if (!redirectUrl) return

		return Response.redirect(redirectUrl, 308)
	})
	.use(
		openapi({
			documentation: {
				info: API_INFO,
				tags: [...API_TAGS]
			},
			mapJsonSchema: { valibot: toJsonSchema }
		})
	)
	.use(
		createStatusRoutes(
			() => ctx.sseState.activeClients,
			() => !ctx.isBootstrapInjected()
		)
	)
	.use(createSessionRoutes(ctx.store))
	.use(
		createChatRoutes(
			ctx.store,
			ctx.sseState,
			ctx.getAgentController,
			ctx.ensureBootstrap,
			ctx.uploadStore,
			ctx.eventStore
		)
	)
	.use(
		createAgentRoutes(
			ctx.store,
			ctx.getAgentController,
			ctx.sseState
		)
	)
	.use(
		createAuthRoutes(
			ctx.CREDENTIALS_PATH,
			ctx.invalidateAgentCache
		)
	)
	.use(
		createGroqAuthRoutes(
			ctx.CREDENTIALS_PATH,
			ctx.invalidateAgentCache
		)
	)
	.use(
		createBraveAuthRoutes(
			ctx.CREDENTIALS_PATH,
			ctx.invalidateAgentCache
		)
	)
	.use(createElevenLabsAuthRoutes(ctx.CREDENTIALS_PATH))
	.use(createCivitaiAuthRoutes(ctx.CREDENTIALS_PATH))
	.use(createChannelRoutes(ctx.channelManager))
	.use(
		createTusApp({
			datastore: ctx.uploadStore,
			relativeLocation: true,
			maxSize: 500 * 1024 * 1024 // 500 MB
		})
	)
	.use(
		createSpeechRoutes(
			ctx.eventStore,
			ctx.DATA_DIR,
			ctx.sttBaseUrl,
			ctx.traceRecorder
		)
	)
	.use(
		createTtsRoutes(
			ctx.blobSink,
			ctx.traceRecorder,
			ctx.CREDENTIALS_PATH
		)
	)
	.use(createDevRoutes(ctx.DATA_DIR))
	.use(createTraceRoutes(ctx.traceRecorder))
	.use(createDbStudioRoutes(ctx.DATA_DIR))
	.use(createTerminalRoutes())
	.use(
		createHindsightApp(ctx.hindsight, {
			record: (scope, kind, component, payload) =>
				ctx.traceRecorder.record(
					scope,
					kind,
					component,
					payload
				),
			factory: { createRootScope, createChildScope }
		})
	)
	.get('/', ({ redirect }) => redirect('/app'))
	.use(
		await staticPlugin({
			assets: ctx.STUDIO_PUBLIC,
			prefix: `/app`,
			indexHTML: false,
			ignorePatterns: [/\.html$/]
		})
	)
	.use(
		await staticPlugin({
			assets: ctx.STUDIO_PUBLIC,
			prefix: `/db`,
			indexHTML: false,
			ignorePatterns: [/\.html$/]
		})
	)
	.use(
		await staticPlugin({
			assets: ctx.STUDIO_PUBLIC,
			prefix: `/terminal`,
			indexHTML: false,
			ignorePatterns: [/\.html$/]
		})
	)
	.use(
		(() => {
			// Serve index.html as a raw string to prevent Bun's
			// automatic HTML processing from re-bundling the JS.
			// Registered AFTER static plugins so asset files are
			// served by the static plugin first.
			const indexPath = join(
				ctx.STUDIO_PUBLIC,
				'index.html'
			)
			let indexHtml: string
			try {
				const raw = readFileSync(indexPath, 'utf-8')
				// Rewrite relative asset paths to absolute under /app/
				indexHtml = raw.replace(
					/(?:href|src)="\.\/([^"]+)"/g,
					(_, file) => {
						const attr = _.startsWith('href')
							? 'href'
							: 'src'
						return `${attr}="/app/${file}"`
					}
				)
			} catch {
				indexHtml =
					'<html><body>index.html not found</body></html>'
			}
			const serveIndex = () =>
				new Response(indexHtml, {
					headers: {
						'content-type': 'text/html; charset=utf-8'
					}
				})
			const app = new Elysia()
			for (const prefix of ['/app', '/db', '/terminal']) {
				app.get(prefix, serveIndex)
				app.get(`${prefix}/*`, serveIndex)
			}
			return app
		})()
	)
	.all(
		`/*`,
		({ set }) => {
			set.status = 404
			return { error: `Not Found` }
		},
		{
			detail: { hide: true },
			response: {
				404: errorSchema
			}
		}
	)
	.onError(({ code, error, set, request }) => {
		if (code === `VALIDATION`) {
			set.status = 400

			const wantsSummary =
				request.headers.get(`x-error-detail`) === `summary`
			const summary =
				wantsSummary &&
				tryValibotSummary(error.validator, error.value)

			return { error: summary || error.message }
		}

		if (error instanceof HttpError) {
			set.status = error.status
			return { error: error.message }
		}

		const message =
			error instanceof Error ? error.message : String(error)
		if (set.status === 200) set.status = 500

		return {
			error: message
		}
	})

export type App = typeof app

app.listen(ctx.port)
console.log(
	`[server] ✅ all systems ready on port ${ctx.port}`
)

// ── Graceful shutdown (close WhatsApp sockets before hot-reload / exit) ──
async function shutdown() {
	await ctx.channelManager.shutdownAll()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Bun --hot sends SIGUSR2 before reload
process.on('SIGUSR2', shutdown)
