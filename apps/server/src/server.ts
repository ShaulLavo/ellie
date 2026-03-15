import { createHindsightApp } from '@ellie/hindsight/server'
import {
	createRootScope,
	createChildScope
} from '@ellie/trace'
import { createTusApp } from '@ellie/tus'
import { openapi } from '@elysiajs/openapi'
import { join } from 'node:path'
import { staticPlugin } from '@elysiajs/static'
import { tryValibotSummary } from '@ellie/schemas'
import { toJsonSchema } from '@valibot/to-json-schema'
import { Elysia } from 'elysia'
import { stopTei } from './lib/tei'
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
import { createAssistantRoutes } from './routes/assistant'
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
	.use(createAssistantRoutes(ctx.store, ctx.sseState))
	.use(
		createChatRoutes({
			store: ctx.store,
			sseState: ctx.sseState,
			getAgentController: ctx.getAgentController,
			ensureBootstrap: ctx.ensureBootstrap,
			uploadStore: ctx.uploadStore,
			eventStore: ctx.eventStore
		})
	)
	.use(
		createAgentRoutes({
			store: ctx.store,
			getAgentController: ctx.getAgentController,
			sseState: ctx.sseState
		})
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
		createSpeechRoutes({
			eventStore: ctx.eventStore,
			dataDir: ctx.DATA_DIR,
			sttBaseUrl: ctx.sttBaseUrl,
			traceRecorder: ctx.traceRecorder
		})
	)
	.use(
		createTtsRoutes({
			blobSink: ctx.blobSink,
			traceRecorder: ctx.traceRecorder,
			credentialsPath: ctx.CREDENTIALS_PATH
		})
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
			prefix: '/'
		})
	)
	.use(
		await (async () => {
			const htmlBundle = await import(
				join(ctx.STUDIO_PUBLIC, 'index.html')
			)
			const spa = new Elysia()
			for (const prefix of [
				'/app',
				'/db',
				'/observe',
				'/terminal',
				'/code'
			]) {
				spa.get(prefix, htmlBundle.default)
				spa.get(`${prefix}/*`, htmlBundle.default)
			}
			return spa
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

async function shutdown() {
	stopTei()
	await ctx.channelManager.shutdownAll()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Bun --hot sends SIGUSR2 before reload
process.on('SIGUSR2', shutdown)
