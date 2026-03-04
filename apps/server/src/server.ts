import { createHindsightApp } from '@ellie/hindsight/server'
import { createTusApp } from '@ellie/tus'
import { openapi } from '@elysiajs/openapi'
import { staticPlugin } from '@elysiajs/static'
import { tryValibotSummary } from '@ellie/schemas'
import { toJsonSchema } from '@valibot/to-json-schema'
import { Elysia } from 'elysia'
import { createAgentRoutes } from './routes/agent'
import {
	createAuthRoutes,
	createGroqAuthRoutes
} from './routes/auth'
import { createChatRoutes } from './routes/chat'
import { errorSchema } from './routes/common'
import { createSessionRoutes } from './routes/session'
import { createStatusRoutes } from './routes/status'
import { createDbStudioRoutes } from './routes/db-studio'
import { createDevRoutes } from './routes/dev'
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
			ctx.ensureBootstrap
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
		createTusApp({
			datastore: ctx.uploadStore,
			relativeLocation: true,
			maxSize: 500 * 1024 * 1024 // 500 MB
		})
	)
	.use(createDevRoutes(ctx.DATA_DIR))
	.use(createDbStudioRoutes(ctx.DATA_DIR))
	.use(createHindsightApp(ctx.hindsight))
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

		const message =
			error instanceof Error ? error.message : String(error)
		const lower = message.toLowerCase()
		if (lower.includes(`not found`)) set.status = 404
		if (
			lower.includes(`missing`) ||
			lower.includes(`empty`) ||
			lower.includes(`invalid`)
		) {
			set.status = 400
		}
		if (set.status === 200) set.status = 500

		return {
			error: message
		}
	})

export type App = typeof app

app.listen(ctx.port)
