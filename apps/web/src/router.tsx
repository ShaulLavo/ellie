import {
	createRouter,
	createRoute,
	createRootRoute,
	Outlet
} from '@tanstack/react-router'
import App from './App'
import { DbStudioPage } from './db-studio'
import { TerminalPage } from './terminal/terminal-page'

// ── Root ─────────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
	component: () => <Outlet />
})

// ── /app → Chat ──────────────────────────────────────────────────────────────

const appRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/app',
	component: App
})

// ── /db → DB Studio ──────────────────────────────────────────────────────────

export interface DbSearchParams {
	database?: string
	table?: string
	page?: number
	pageSize?: number
	sortBy?: string
	sortDir?: 'asc' | 'desc'
	filter?: string
}

const dbRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/db',
	component: DbStudioPage,
	validateSearch: (
		search: Record<string, unknown>
	): DbSearchParams => ({
		database: (search.database as string) || undefined,
		table: (search.table as string) || undefined,
		page: search.page ? Number(search.page) : undefined,
		pageSize: search.pageSize
			? Number(search.pageSize)
			: undefined,
		sortBy: (search.sortBy as string) || undefined,
		sortDir: search.sortDir === 'desc' ? 'desc' : undefined,
		filter: (search.filter as string) || undefined
	})
})

// ── /terminal → TUI in the browser ──────────────────────────────────────────

const terminalRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/terminal',
	component: TerminalPage
})

// ── Router ───────────────────────────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
	appRoute,
	dbRoute,
	terminalRoute
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
