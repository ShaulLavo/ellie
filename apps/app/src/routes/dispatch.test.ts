import { describe, expect, it } from "bun:test"
import type { PartialProcedureHandlers } from "@ellie/rpc/server"
import type { AppRouter } from "@ellie/router"
import { dispatchAppApiRequest } from "./dispatch"

function createOptions(
	overrides: Partial<{
		procedureHandlers: PartialProcedureHandlers<AppRouter>
		agentProceduresEnabled: boolean
		handleStreamRequest: (req: Request, pathname: string) => Promise<Response>
	}> = {},
) {
	return {
		procedureHandlers: {},
		agentProceduresEnabled: true,
		handleStreamRequest: async () => new Response("stream", { status: 200 }),
		...overrides,
	}
}

describe("dispatchAppApiRequest", () => {
	it("returns 503 for agent procedures when agent manager is unavailable", async () => {
		const req = new Request("http://localhost/agent/chat-1/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		})

		const response = await dispatchAppApiRequest(
			req,
			"/agent/chat-1/prompt",
			createOptions({ agentProceduresEnabled: false }),
		)

		expect(response).not.toBeNull()
		expect(response?.status).toBe(503)
	})

	it("dispatches matched procedures via handleProcedureRequest", async () => {
		const req = new Request("http://localhost/agent/chat-1/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		})

		const response = await dispatchAppApiRequest(
			req,
			"/agent/chat-1/prompt",
			createOptions({
				procedureHandlers: {
					agentPrompt: async (_input, params) => ({
						runId: "run-1",
						chatId: params.chatId,
						status: "started",
					}),
				},
			}),
		)

		expect(response).not.toBeNull()
		expect(response?.status).toBe(200)
		expect(await response?.json()).toEqual({
			runId: "run-1",
			chatId: "chat-1",
			status: "started",
		})
	})

	it("dispatches matched streams", async () => {
		let observedPath = ""
		const req = new Request("http://localhost/chat/room-1", { method: "GET" })

		const response = await dispatchAppApiRequest(
			req,
			"/chat/room-1",
			createOptions({
				handleStreamRequest: async (_req, pathname) => {
					observedPath = pathname
					return new Response("ok", { status: 202 })
				},
			}),
		)

		expect(response?.status).toBe(202)
		expect(observedPath).toBe("/chat/room-1")
	})

	it("enforces read-only policy for the agent message stream", async () => {
		let streamCalled = false
		const req = new Request("http://localhost/agent/chat-1", { method: "POST" })

		const response = await dispatchAppApiRequest(
			req,
			"/agent/chat-1",
			createOptions({
				handleStreamRequest: async () => {
					streamCalled = true
					return new Response("unexpected")
				},
			}),
		)

		expect(response?.status).toBe(405)
		expect(streamCalled).toBe(false)
	})

	it("does not route legacy /streams/* aliases", async () => {
		const req = new Request("http://localhost/streams/chat/room-1", {
			method: "GET",
		})

		const response = await dispatchAppApiRequest(
			req,
			"/streams/chat/room-1",
			createOptions(),
		)

		expect(response).toBeNull()
	})

	it("skips unmatched procedure handlers instead of returning 501", async () => {
		const req = new Request("http://localhost/banks", { method: "GET" })

		const response = await dispatchAppApiRequest(
			req,
			"/banks",
			createOptions({ procedureHandlers: {} }),
		)

		expect(response).toBeNull()
	})
})
