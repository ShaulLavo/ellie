import {
	findMatchingProcedure,
	findMatchingStream,
	handleProcedureRequest,
	type PartialProcedureHandlers,
} from "@ellie/rpc/server"
import { appRouter, type AppRouter } from "@ellie/router"

const AGENT_PROCEDURE_NAMES = new Set([
	"agentPrompt",
	"agentSteer",
	"agentAbort",
	"agentHistory",
])

const STREAM_METHOD_POLICY: Record<string, readonly string[]> = {
	agent: ["GET", "PUT"],
}

function isMethodAllowedForStream(streamName: string, method: string): boolean {
	const allowed = STREAM_METHOD_POLICY[streamName]
	if (!allowed) return true
	return allowed.includes(method.toUpperCase())
}

export interface AppApiDispatchOptions {
	procedureHandlers: PartialProcedureHandlers<AppRouter>
	agentProceduresEnabled: boolean
	handleStreamRequest: (req: Request, pathname: string) => Promise<Response>
}

export async function dispatchAppApiRequest(
	req: Request,
	pathname: string,
	options: AppApiDispatchOptions,
): Promise<Response | null> {
	const matchedProcedure = findMatchingProcedure(
		appRouter._def,
		pathname,
		req.method,
	)

	if (
		matchedProcedure &&
		!options.agentProceduresEnabled &&
		AGENT_PROCEDURE_NAMES.has(matchedProcedure.name)
	) {
		return Response.json(
			{ error: "Agent routes unavailable: no ANTHROPIC_API_KEY configured" },
			{ status: 503 },
		)
	}

	const procedureResponse = handleProcedureRequest(
		appRouter._def,
		req,
		pathname,
		options.procedureHandlers,
		{ onMissingHandler: "skip" },
	)
	if (procedureResponse) {
		return procedureResponse
	}

	const matchedStream = findMatchingStream(appRouter._def, pathname)
	if (!matchedStream) return null

	if (!isMethodAllowedForStream(matchedStream.name, req.method)) {
		return new Response("Method not allowed", { status: 405 })
	}

	return options.handleStreamRequest(req, pathname)
}
