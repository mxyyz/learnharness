import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PluginFrontendManager, type PluginHost } from "../components/plugin-manager.ts";
import {
	getSttBackend, getSttBackendsSnapshot, registerSttBackend, subscribeSttBackends,
	validateSttBackend, validateSttConnection,
} from "../components/dictation-backends.ts";
import type { PluginFrontendModule, PluginInfo, PluginSttBackend } from "../src/core/index.ts";

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function backend(id = "test-stt", overrides: Partial<PluginSttBackend> = {}): PluginSttBackend {
	return {
		id, label: `Backend ${id}`,
		connect: () => ({
			url: "wss://stt.example/v1/audio/stream",
			encodeAudio: frame => frame,
			parseMessage: () => null,
			stopFrame: '{"type":"stop"}',
		}),
		...overrides,
	};
}

function info(id = "fixture", overrides: Partial<PluginInfo> = {}): PluginInfo {
	return { id, origin: "community", enabled: true, status: "active", revision: "restart-1", manifest: {
		apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.3.7", main: "main.js",
	}, ...overrides };
}
function fixture(frontend: PluginFrontendModule) {
	const host: PluginHost = {
		fetch: async () => Response.json({ plugins: [], directory: "/fixture/plugins" }),
		importModule: async () => frontend,
		pathname: () => "/", navigate: () => {},
	};
	return new PluginFrontendManager(host);
}

describe("stt backend registry", () => {
	it("registers, snapshots, looks up and unregisters with publish notifications", () => {
		let notifications = 0;
		const off = subscribeSttBackends(() => { notifications++; });
		const unregister = registerSttBackend("fixture-plugin", backend("reg-a"));
		assert.equal(notifications, 1);
		assert.equal(getSttBackend("reg-a")?.pluginId, "fixture-plugin");
		assert.equal(getSttBackend("reg-a")?.backend.label, "Backend reg-a");
		assert.ok(getSttBackendsSnapshot().some(r => r.backend.id === "reg-a"));
		unregister();
		assert.equal(notifications, 2);
		assert.equal(getSttBackend("reg-a"), undefined);
		unregister(); // idempotent
		assert.equal(notifications, 2);
		off();
	});

	it("rejects malformed backends and duplicate ids", () => {
		assert.throws(() => registerSttBackend("p", backend("bad id!")), /route-safe/);
		assert.throws(() => registerSttBackend("p", backend("x", { label: "  " } as Partial<PluginSttBackend>)), /label/);
		assert.throws(() => registerSttBackend("p", { id: "x", label: "X" } as unknown as PluginSttBackend), /connect/);
		const off = registerSttBackend("p", backend("dup"));
		assert.throws(() => registerSttBackend("q", backend("dup")), /Duplicate STT backend/);
		off();
	});

	it("freezes the registration so plugin-side mutation cannot affect the host", () => {
		const b = backend("frozen");
		const off = registerSttBackend("p", b);
		(b as { label: string }).label = "mutated";
		assert.equal(getSttBackend("frozen")?.backend.label, "Backend frozen");
		assert.throws(() => Object.assign(getSttBackend("frozen")!.backend, { label: "x" }), TypeError);
		off();
	});

	it("validates connection objects returned by connect", () => {
		assert.throws(() => validateSttConnection(null), /connection object/);
		assert.throws(() => validateSttConnection({ url: "" , encodeAudio() {}, parseMessage() {} }), /url/);
		assert.throws(() => validateSttConnection({ url: "wss://x", encodeAudio: 1, parseMessage() {} }), /encodeAudio/);
		const ok = validateSttConnection({ url: "wss://x", protocols: ["p"], startFrames: ['{"type":"start"}'], encodeAudio: (f: ArrayBuffer) => f, parseMessage: () => null, stopFrame: '{"type":"stop"}' });
		assert.equal(ok.url, "wss://x");
		assert.doesNotThrow(() => validateSttBackend(backend("shape-ok")));
	});
});

describe("plugin manager registerSttBackend wiring", () => {
	it("registers on activate and unregisters on disable (activation-scoped)", async () => {
		let ctx!: import("../src/core/index.ts").PluginFrontendContext;
		const manager = fixture({ activate(c) { ctx = c; c.registerSttBackend(backend("plugin-stt")); } });
		manager.reconcile([info()]); await tick();
		assert.equal(getSttBackend("plugin-stt")?.pluginId, "fixture");
		manager.reconcile([info("fixture", { enabled: false, status: "disabled" })]); await tick();
		assert.equal(getSttBackend("plugin-stt"), undefined);
		manager.dispose();
	});

	it("the returned unregister removes the backend without disabling the plugin", async () => {
		let unregister!: () => void;
		const manager = fixture({ activate(c) { unregister = c.registerSttBackend(backend("manual-off")); } });
		manager.reconcile([info()]); await tick();
		assert.ok(getSttBackend("manual-off"));
		unregister();
		assert.equal(getSttBackend("manual-off"), undefined);
		manager.dispose();
	});

	it("invalid or duplicate registrations throw and are reported, not stored", async () => {
		let caught: unknown;
		const manager = fixture({ activate(c) {
			try { c.registerSttBackend({ id: "bad id", label: "x", connect() { throw new Error("never"); } }); } catch (error) { caught = error; }
			c.registerSttBackend(backend("dupe"));
			try { c.registerSttBackend(backend("dupe")); } catch (error) { caught = error; }
		} });
		manager.reconcile([info()]); await tick();
		assert.match(String(caught), /Duplicate STT backend/);
		assert.equal(getSttBackend("dupe")?.pluginId, "fixture");
		assert.equal(getSttBackend("bad id"), undefined);
		manager.dispose();
	});
});
