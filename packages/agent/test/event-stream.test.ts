import { describe, expect, test } from "bun:test";
import { EventStream } from "../src/event-stream";

type TestEvent =
	| { type: "data"; value: string }
	| { type: "end"; result: string };

function createTestStream() {
	return new EventStream<TestEvent, string>(
		(e) => e.type === "end",
		(e) => (e.type === "end" ? e.result : ""),
	);
}

describe("EventStream", () => {
	test("iterates pushed events in order", async () => {
		const stream = createTestStream();

		stream.push({ type: "data", value: "a" });
		stream.push({ type: "data", value: "b" });
		stream.push({ type: "end", result: "done" });
		stream.end("done");

		const events: TestEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toEqual([
			{ type: "data", value: "a" },
			{ type: "data", value: "b" },
			{ type: "end", result: "done" },
		]);
	});

	test("waits for events when queue is empty", async () => {
		const stream = createTestStream();

		const events: TestEvent[] = [];
		const iterPromise = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		// Push after iteration starts
		await Bun.sleep(10);
		stream.push({ type: "data", value: "delayed" });
		stream.push({ type: "end", result: "done" });
		stream.end("done");

		await iterPromise;

		expect(events).toEqual([
			{ type: "data", value: "delayed" },
			{ type: "end", result: "done" },
		]);
	});

	test("result() resolves with extracted result", async () => {
		const stream = createTestStream();

		stream.push({ type: "data", value: "x" });
		stream.push({ type: "end", result: "final" });
		stream.end("final");

		const result = await stream.result();
		expect(result).toBe("final");
	});

	test("result() resolves when end() provides result directly", async () => {
		const stream = createTestStream();
		stream.end("direct");

		const result = await stream.result();
		expect(result).toBe("direct");
	});

	test("ignores push after end", async () => {
		const stream = createTestStream();

		stream.push({ type: "data", value: "before" });
		stream.end("done");
		stream.push({ type: "data", value: "after" });

		const events: TestEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toEqual([{ type: "data", value: "before" }]);
	});

	test("end() is idempotent", async () => {
		const stream = createTestStream();
		stream.end("first");
		stream.end("second");

		const result = await stream.result();
		expect(result).toBe("first");
	});

	test("handles empty stream", async () => {
		const stream = createTestStream();
		stream.end("empty");

		const events: TestEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toEqual([]);
	});

	test("result() rejects when end() called without result and no completion event", async () => {
		const stream = createTestStream();
		stream.push({ type: "data", value: "x" });
		stream.end(); // No result argument, no "end" event was pushed

		await expect(stream.result()).rejects.toThrow(
			"EventStream ended without a result",
		);
	});

	test("result() resolves when completion event was pushed even if end() has no arg", async () => {
		const stream = createTestStream();
		stream.push({ type: "end", result: "from-push" }); // Sets finalResult via isComplete
		stream.end(); // No explicit result arg, but finalResult was set by push()

		const result = await stream.result();
		expect(result).toBe("from-push");
	});

	test("handles interleaved push and consume", async () => {
		const stream = createTestStream();
		const events: TestEvent[] = [];

		const iterPromise = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		for (let i = 0; i < 5; i++) {
			await Bun.sleep(5);
			stream.push({ type: "data", value: String(i) });
		}
		stream.push({ type: "end", result: "done" });
		stream.end("done");

		await iterPromise;

		expect(events.length).toBe(6);
		expect(events[0]).toEqual({ type: "data", value: "0" });
		expect(events[4]).toEqual({ type: "data", value: "4" });
		expect(events[5]).toEqual({ type: "end", result: "done" });
	});
});
