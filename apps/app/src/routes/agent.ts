/**
 * Agent HTTP routes — prompt, steer, abort, history.
 *
 * Stream reads (subscribing to messages/events) go through the
 * standard durable stream handler in streams.ts.
 */

import type { AgentManager } from "../agent/manager";

/**
 * Handle agent-specific action routes.
 * Returns a Response Promise if matched, or null.
 */
export function handleAgentRequest(
	agentManager: AgentManager,
	req: Request,
	pathname: string,
): Promise<Response> | null {
	// POST /agent/:chatId/prompt
	const promptMatch = pathname.match(/^\/agent\/([^/]+)\/prompt$/);
	if (promptMatch && req.method === "POST") {
		return handlePrompt(agentManager, req, promptMatch[1]);
	}

	// POST /agent/:chatId/steer
	const steerMatch = pathname.match(/^\/agent\/([^/]+)\/steer$/);
	if (steerMatch && req.method === "POST") {
		return handleSteer(agentManager, req, steerMatch[1]);
	}

	// POST /agent/:chatId/abort
	const abortMatch = pathname.match(/^\/agent\/([^/]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		return handleAbort(agentManager, abortMatch[1]);
	}

	// GET /agent/:chatId/history
	const historyMatch = pathname.match(/^\/agent\/([^/]+)\/history$/);
	if (historyMatch && req.method === "GET") {
		return handleHistory(agentManager, historyMatch[1]);
	}

	return null;
}

async function handlePrompt(
	manager: AgentManager,
	req: Request,
	chatId: string,
): Promise<Response> {
	try {
		const body = await req.json() as { message?: string };
		if (!body.message || typeof body.message !== "string") {
			return Response.json(
				{ error: "Missing 'message' field in request body" },
				{ status: 400 },
			);
		}

		const { runId } = await manager.prompt(chatId, body.message);

		return Response.json({ runId, chatId, status: "started" });
	} catch (err: any) {
		return Response.json(
			{ error: err?.message || "Failed to start prompt" },
			{ status: 500 },
		);
	}
}

async function handleSteer(
	manager: AgentManager,
	req: Request,
	chatId: string,
): Promise<Response> {
	try {
		const body = await req.json() as { message?: string };
		if (!body.message || typeof body.message !== "string") {
			return Response.json(
				{ error: "Missing 'message' field in request body" },
				{ status: 400 },
			);
		}

		manager.steer(chatId, body.message);
		return Response.json({ status: "queued" });
	} catch (err: any) {
		return Response.json(
			{ error: err?.message || "Failed to steer" },
			{ status: 500 },
		);
	}
}

async function handleAbort(
	manager: AgentManager,
	chatId: string,
): Promise<Response> {
	try {
		manager.abort(chatId);
		return Response.json({ status: "aborted" });
	} catch (err: any) {
		return Response.json(
			{ error: err?.message || "Failed to abort" },
			{ status: 500 },
		);
	}
}

async function handleHistory(
	manager: AgentManager,
	chatId: string,
): Promise<Response> {
	try {
		const messages = manager.loadHistory(chatId);
		return Response.json({ messages });
	} catch (err: any) {
		return Response.json(
			{ error: err?.message || "Failed to load history" },
			{ status: 500 },
		);
	}
}
