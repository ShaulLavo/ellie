import { createHindsightApp } from '@ellie/hindsight/server'
import {
	createRootScope,
	createChildScope
} from '@ellie/trace'
import { createTusApp } from '@ellie/tus'
import { openapi } from '@elysiajs/openapi'
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

const ctx = await init()

export const app = new Elysia()
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
			indexHTML: true
		})
	)
	.use(
		await staticPlugin({
			assets: ctx.STUDIO_PUBLIC,
			prefix: `/db`,
			indexHTML: true
		})
	)
	.use(
		await staticPlugin({
			assets: ctx.STUDIO_PUBLIC,
			prefix: `/terminal`,
			indexHTML: true
		})
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

// ── Graceful shutdown (close WhatsApp sockets before hot-reload / exit) ──
async function shutdown() {
	await ctx.channelManager.shutdownAll()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Bun --hot sends SIGUSR2 before reload
process.on('SIGUSR2', shutdown)
