import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { registerSttBackend } from "../components/dictation-backends.ts";
import { streamLanguage, type PluginSttBackend, type PluginSttEvent } from "../src/core/index.ts";
import type { UserSettings } from "../src/core/index.ts";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols?: string[]) { super(); Socket.all.push(this); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	end(code = 1000) { this.close(); this.dispatchEvent(Object.assign(new Event("close"), { code })); }
	/** transcribe-server-style server frames. */
	partial(text: string) {
		this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "partial", text }) }));
	}
	final(text: string) {
		this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "final", text }) }));
	}
	error(message: string) {
		this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "error", message }) }));
	}
	unknown() {
		this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "stats", n: 1 }) }));
	}
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
	constructor() { Worklet.all.push(this); }
	connect() {} disconnect() {}
	emit(data: unknown) { this.port.onmessage?.({ data }); }
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;
let unregisterBackend: (() => void) | undefined;

/** A fake plugin-registered transcribe-server-style ws backend. */
function fakeBackend(id = "test-stt", hooks: { connects?: number; encode?: (f: ArrayBuffer) => string | ArrayBufferLike; parse?: (d: string) => PluginSttEvent | null } = {}): PluginSttBackend {
	return {
		id,
		label: `Fake ${id}`,
		connect(input) {
			hooks.connects = (hooks.connects ?? 0) + 1;
			const start: Record<string, unknown> = { type: "start" };
			if (input.model) start.model = input.model;
			const language = streamLanguage(input.language as Parameters<typeof streamLanguage>[0]);
			if (language) start.language = language;
			return {
				url: input.url,
				startFrames: [JSON.stringify(start)],
				encodeAudio: hooks.encode ?? (frame => frame),
				parseMessage: hooks.parse ?? ((data) => {
					const msg = JSON.parse(data) as { type: string; text?: string; message?: string };
					if (msg.type === "partial") return { partial: msg.text };
					if (msg.type === "final") return { final: msg.text };
					if (msg.type === "error") return { error: msg.message ?? "STT error" };
					return null;
				}),
				stopFrame: JSON.stringify({ type: "stop" }),
			};
		},
	};
}

async function fixture(record: UserSettings) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record,
		tokenMints: 0,
		captures: 0,
		stops: 0,
		appends: [] as string[],
	};
	Socket.all = [];
	Worklet.all = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.tokenMints++; return Response.json({ token: "test-token" }); }
			if (url === "/api/settings") return Response.json({ settings: state.record });
			assert.equal(url, "/api/settings/dictation");
			assert.equal(init?.method, "PUT");
			state.record = { ...state.record, dictation: JSON.parse(init.body as string) };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		return null;
	}
	let root = createRoot(document.getElementById("root")!);
	let firstMount = true;
	const mount = async () => {
		await act(async () => { root.render(<Harness />); });
		if (firstMount) {
			await act(async () => { notifySettingsSaved("dictation"); });
		}
		firstMount = false;
	};
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		mount,
		unmount: () => dispose!(),
	};
}

const wsRecord = (dictation: Record<string, unknown>): UserSettings => ({
	version: 1,
	dictation: { language: "en-GB", provider: "ws", backend: "test-stt", stream: { url: "wss://stt.test/v1/audio/stream", model: "voxtral" }, ...dictation },
});

afterEach(async () => {
	await dispose?.();
	unregisterBackend?.();
	unregisterBackend = undefined;
	restore?.();
	restore = undefined;
	dispose = undefined;
});

test("ws run: adapter drives the wire — start frame, encoded audio, partials ignored, final flushes once on stop", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend());
	const f = await fixture(wsRecord({}));
	await f.mount();
	assert.equal(f.state.tokenMints, 0, "ws provider never mints a deepgram token");
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	assert.equal(socket.url, "wss://stt.test/v1/audio/stream");
	await act(async () => {
		socket.open();
		assert.deepEqual(socket.sent[0], JSON.stringify({ type: "start", model: "voxtral", language: "en" }), "alpha-2 mapped language in the start frame");
		const worklet = Worklet.all[0]!;
		const frame = new ArrayBuffer(4096);
		worklet.emit({ type: "audio", buffer: frame });
		assert.equal(socket.sent[1], frame, "encodeAudio passthrough reaches the socket");
		socket.partial("ignored live words");
		socket.unknown();
		socket.final("Hello there");
		assert.deepEqual(f.state.appends, [], "deferred: nothing renders while recording");
	});
	await act(async () => { f.dictation.stop(); });
	assert.deepEqual(Socket.all[0]!.sent.at(-1), JSON.stringify({ type: "stop" }), "stop frame from the adapter");
	await act(async () => { Socket.all[0]!.end(); });
	assert.deepEqual(f.state.appends, ["Hello there"], "final flushed exactly once at teardown");
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.tokenMints, 0);
});

test("ws run without a registered backend errors honestly before touching the mic", async () => {
	const f = await fixture(wsRecord({})); // no backend registered
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error ?? "", /test-stt.*unavailable|enable its plugin/);
	assert.equal(f.state.captures, 0);
	assert.equal(Socket.all.length, 0);
});

test("ws run without a stream URL names the missing configuration", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend());
	const f = await fixture(wsRecord({ stream: { model: "voxtral" } }));
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error ?? "", /stream URL/);
	assert.equal(Socket.all.length, 0);
});

test("backend unregistering mid-run aborts the run with a terminal error", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend());
	const f = await fixture(wsRecord({}));
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.final("partial work"); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { unregisterBackend!(); unregisterBackend = undefined; });
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error ?? "", /was disabled/);
	assert.deepEqual(f.state.appends, ["partial work"], "error paths never lose already-delivered speech (matches Deepgram)");
	// a new run can start cleanly after re-registering
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend());
	await act(async () => { f.dictation.clearError(); f.dictation.toggle(); });
	assert.equal(Socket.all.length, 2);
	assert.equal(f.dictation.phase, "connecting");
});

test("adapter error event ends the run and surfaces the message", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend());
	const f = await fixture(wsRecord({}));
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.error("model not loaded"); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "model not loaded");
	assert.deepEqual(f.state.appends, []);
});

test("abnormal close reconnects once with a fresh connect, then a second drop ends with connection-lost", async () => {
	const hooks: { connects?: number } = {};
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend("test-stt", hooks));
	const f = await fixture(wsRecord({}));
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const first = Socket.all[0]!;
	await act(async () => { first.open(); first.end(1006); });
	assert.equal(Socket.all.length, 2, "one reconnect opened a second socket");
	assert.equal(hooks.connects, 2, "reconnect re-ran the adapter connect");
	const second = Socket.all[1]!;
	await act(async () => {
		second.open();
		assert.deepEqual(second.sent[0], JSON.stringify({ type: "start", model: "voxtral", language: "en" }), "start frame re-sent on the reconnected socket");
		second.final("resumed");
		second.end(1006);
	});
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error ?? "", /STT connection lost \(1006\)/);
});

test("stop is terminal: finals after stop buffer, and a close during stopping finalizes without reconnecting", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend());
	const f = await fixture(wsRecord({}));
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => { socket.open(); socket.partial("live words"); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping", "waiting state held after stop, not just until audio is sent");
	assert.deepEqual(socket.sent.at(-1), JSON.stringify({ type: "stop" }));
	await act(async () => { socket.final("late final"); });
	assert.equal(f.dictation.phase, "stopping", "still waiting for the server to end the session");
	assert.deepEqual(f.state.appends, [], "nothing renders while stopping");
	await act(async () => { socket.end(1006); }); // abnormal close DURING stopping
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, ["late final"], "buffered final flushed once at finalize");
	assert.equal(Socket.all.length, 1, "a run that is stopping is never reconnected, whatever the close code");
});

test("a throwing adapter (encodeAudio) becomes a terminal error, never a crash", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend("test-stt", { encode: () => { throw new Error("bad frame"); } }));
	const f = await fixture(wsRecord({}));
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	const socket = Socket.all[0]!;
	await act(async () => {
		socket.open();
		Worklet.all[0]!.emit({ type: "audio", buffer: new ArrayBuffer(8) });
	});
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "bad frame");
});
