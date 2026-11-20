import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { setDictationActive } from "../components/dictation-state.ts";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { registerSttBackend } from "../components/dictation-backends.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import type { PluginSttBackend, UserSettings } from "../src/core/index.ts";

let dispose: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
let unregisterBackend: (() => void) | undefined;
const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;

function fakeBackend(id: string): PluginSttBackend {
	return {
		id,
		label: `Fake ${id}`,
		connect: (input) => ({
			url: input.url,
			encodeAudio: (frame) => frame,
			parseMessage: () => null,
			stopFrame: '{"type":"stop"}',
		}),
	};
}

async function fixture(record: UserSettings) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(win, { innerWidth: 1280, innerHeight: 900 });
	const state = {
		record,
		writes: [] as Record<string, unknown>[],
		failWrite: false,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, Element: win.Element, HTMLElement: win.HTMLElement,
		HTMLInputElement: win.HTMLInputElement, Event: win.Event, CustomEvent: win.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/settings") return Response.json({ settings: state.record });
			assert.equal(url, "/api/settings/dictation");
			assert.equal(init?.method, "PUT");
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			// Mirror the real route: the write side validates strictly.
			const parsed = parseDictationSettingsBody(body);
			if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
			state.writes.push(body);
			if (state.failWrite) return Response.json({}, { status: 500 });
			state.record = { ...state.record, dictation: parsed.settings };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const { createRoot } = await import("react-dom/client");
	const { DictationProviderSetting } = await import("../components/dictation-provider.tsx");
	const root = createRoot(doc.getElementById("root")!);
	let firstMount = true;
	const mount = async () => {
		await act(async () => { root.render(<DictationProviderSetting />); });
		if (firstMount) await act(async () => { notifySettingsSaved("dictation"); });
		firstMount = false;
	};
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { state, mount, unmount: () => dispose!() };
}

const select = (id: string, value: string) => act(async () => {
	const el = byTest(id) as unknown as HTMLSelectElement;
	Object.defineProperty(el, "value", { configurable: true, writable: true, value });
	el.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const commitInput = async (id: string, value: string) => {
	const el = byTest(id) as unknown as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
	// React delegates onBlur through focusout.
	await act(async () => { el.dispatchEvent(new window.Event("focusout", { bubbles: true })); });
};

afterEach(async () => {
	await dispose?.();
	unregisterBackend?.();
	unregisterBackend = undefined;
	restore?.();
	restore = undefined;
	dispose = undefined;
	setDictationActive(false);
});

test("default provider is deepgram and the ws-only rows are hidden", async () => {
	const f = await fixture({ version: 1, dictation: { language: "en" } });
	await f.mount();
	const providerSelect = byTest("dictation-provider") as unknown as HTMLSelectElement;
	assert.equal(providerSelect.value, "deepgram");
	assert.deepEqual([...providerSelect.options].map((o) => o.textContent), ["Deepgram (cloud)", "Plugin (websocket)"]);
	assert.equal(document.querySelector('[data-testid="row-dictation-backend"]'), null);
	assert.equal(document.querySelector('[data-testid="row-dictation-stream-url"]'), null);
	assert.equal(document.querySelector('[data-testid="row-dictation-stream-model"]'), null);
});

test("switching to ws persists the merged section and reveals backend/url/model rows fed by the live registry", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend("transcribe-server"));
	const f = await fixture({ version: 1, dictation: { language: "en" } });
	await f.mount();
	await select("dictation-provider", "ws");
	assert.deepEqual(f.state.writes[0], { language: "en", provider: "ws" }, "replace-whole PUT carries the existing language");
	assert.ok(byTest("row-dictation-backend"));
	assert.ok(byTest("row-dictation-stream-url"));
	assert.ok(byTest("row-dictation-stream-model"));
	const backendSelect = byTest("dictation-backend") as unknown as HTMLSelectElement;
	assert.deepEqual([...backendSelect.options].map((o) => o.value), ["", "transcribe-server"]);
	assert.equal(backendSelect.options[1]!.textContent, "Fake transcribe-server (transcribe-server)", "label + id shown when they differ");
	assert.equal((byTest("dictation-stream-url") as unknown as HTMLInputElement).placeholder, "wss://stt.example.com/v1/audio/stream", "generic placeholder, not a homelab default");
	// live registry update: a backend registered after render appears without reload
	await act(async () => { unregisterBackend!(); unregisterBackend = registerSttBackend("test-plugin", fakeBackend("second-stt")); });
	assert.deepEqual([...backendSelect.options].map((o) => o.value), ["", "second-stt"]);
	// a backend whose label IS its id renders the name once, not duplicated
	await act(async () => { unregisterBackend!(); unregisterBackend = registerSttBackend("test-plugin", { ...fakeBackend("plain-stt"), label: "plain-stt" }); });
	assert.equal(backendSelect.options[1]!.textContent, "plain-stt");
});

test("stored backend without a live registration is shown as missing, and choosing it persists", async () => {
	const f = await fixture({ version: 1, dictation: { language: "en", provider: "ws", backend: "gone-stt" } });
	await f.mount();
	const backendSelect = byTest("dictation-backend") as unknown as HTMLSelectElement;
	assert.equal(backendSelect.value, "gone-stt");
	assert.match(backendSelect.options[0]!.textContent, /gone-stt.*missing/);
	await select("dictation-backend", "gone-stt");
	assert.deepEqual(f.state.writes[0], { language: "en", provider: "ws", backend: "gone-stt" });
});

test("committing the stream URL PUTs the whole merged section with the normalized stream", async () => {
	unregisterBackend = registerSttBackend("test-plugin", fakeBackend("transcribe-server"));
	const f = await fixture({ version: 1, dictation: { language: "en", provider: "ws", backend: "transcribe-server" } });
	await f.mount();
	await commitInput("dictation-stream-url", "wss://stt.homelab.internal/v1/audio/stream");
	assert.deepEqual(f.state.writes[0], {
		language: "en", provider: "ws", backend: "transcribe-server",
		stream: { url: "wss://stt.homelab.internal/v1/audio/stream" },
	});
	await commitInput("dictation-stream-model", "voxtral");
	assert.deepEqual(f.state.writes[1], {
		language: "en", provider: "ws", backend: "transcribe-server",
		stream: { url: "wss://stt.homelab.internal/v1/audio/stream", model: "voxtral" },
	}, "model commit keeps the stored url");
	// clearing the url drops the key instead of sending an invalid empty string
	await commitInput("dictation-stream-url", "");
	assert.deepEqual(f.state.writes[2], {
		language: "en", provider: "ws", backend: "transcribe-server",
		stream: { model: "voxtral" },
	});
});

test("an invalid stream URL is rejected by the server and the write fails without clobbering the record", async () => {
	const f = await fixture({ version: 1, dictation: { language: "en", provider: "ws", backend: "b" } });
	await f.mount();
	await commitInput("dictation-stream-url", "http://not-ws.example");
	assert.equal(f.state.writes.length, 0, "the server-side parser rejected the non-ws URL");
	assert.deepEqual(f.state.record.dictation, { language: "en", provider: "ws", backend: "b" }, "rejected write leaves the record unchanged");
});

test("all provider controls lock while a dictation run is active", async () => {
	const f = await fixture({ version: 1, dictation: { language: "en", provider: "ws", backend: "b", stream: { url: "wss://x/s", model: "m" } } });
	await f.mount();
	await act(async () => { setDictationActive(true); });
	assert.equal((byTest("dictation-provider") as unknown as HTMLSelectElement).disabled, true);
	assert.equal((byTest("dictation-backend") as unknown as HTMLSelectElement).disabled, true);
	assert.equal((byTest("dictation-stream-url") as unknown as HTMLInputElement).disabled, true);
	assert.equal((byTest("dictation-stream-model") as unknown as HTMLInputElement).disabled, true);
	await act(async () => { setDictationActive(false); });
	assert.equal((byTest("dictation-provider") as unknown as HTMLSelectElement).disabled, false);
});
