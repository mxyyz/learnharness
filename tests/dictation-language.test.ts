import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DICTATION_LANGUAGES, DICTATION_PROVIDERS, deepgramListenUrl, isDictationLanguage, isDictationProvider, normalizeStreamUrl, streamLanguage } from "../src/core/dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

describe("Nova-3 dictation language contract", () => {
	it("offers monolingual languages/locales and a distinct multilingual mode", () => {
		assert.equal(DICTATION_LANGUAGES[0]?.code, "multi");
		assert.equal(new Set(DICTATION_LANGUAGES.map((item) => item.code)).size, DICTATION_LANGUAGES.length);
		for (const code of ["en", "fr", "ru", "sv", "pl", "en-GB", "pt-BR", "zh-Hant", "ar-EG", "multi"]) {
			assert.ok(isDictationLanguage(code), code);
		}
		// Xhosa and Zulu are documented for multi, not monolingual Nova-3.
		for (const code of ["xh", "zu", "en-CA", "auto", "xx", "pl&model=other", null, 3]) {
			assert.equal(isDictationLanguage(code), false, String(code));
		}
		const labels = DICTATION_LANGUAGES.slice(1).map((item) => item.label);
		assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, "en")));
	});

	it("only language varies in the streaming URL; all tuned parameters survive", () => {
		for (const { code: language } of DICTATION_LANGUAGES) {
			const url = new URL(deepgramListenUrl(language));
			assert.equal(url.origin + url.pathname, "wss://api.deepgram.com/v1/listen");
			assert.deepEqual(Object.fromEntries(url.searchParams), {
				model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1",
				smart_format: "true", punctuate: "true", endpointing: "300", language,
			});
		}
	});

	it("old records default to English and explicit preferences resolve without a migration", () => {
		assert.equal(resolveSettings(null).dictation.language, "en");
		assert.equal(resolveSettings({ version: 1 }).dictation.language, "en");
		for (const language of ["pl", "multi", "en-GB"] as const) {
			const record = sanitizeUserSettings({ version: 1, dictation: { language } });
			assert.equal(record?.version, 1);
			assert.equal(resolveSettings(record).dictation.language, language);
		}
	});

	it("rejects invalid API values and drops invalid stored preferences", () => {
		assert.deepEqual(parseDictationSettingsBody({}), { ok: true, settings: {} });
		assert.deepEqual(parseDictationSettingsBody({ language: "multi" }), { ok: true, settings: { language: "multi" } });
		for (const value of [null, [], "pl", { language: "xx" }, { language: null }, { language: 3 }]) {
			assert.equal(parseDictationSettingsBody(value).ok, false);
		}
		for (const dictation of [null, [], "pl", { language: "xx" }, { language: 3 }]) {
			const record = sanitizeUserSettings({ version: 1, dictation, general: { autoUpdate: false } });
			assert.equal(resolveSettings(record).dictation.language, "en");
			assert.equal(record?.general?.autoUpdate, false);
		}
	});
});

describe("dictation provider / ws stream settings", () => {
	it("provider literals: deepgram default, ws selectable", () => {
		assert.deepEqual([...DICTATION_PROVIDERS], ["deepgram", "ws"]);
		assert.ok(isDictationProvider("deepgram") && isDictationProvider("ws"));
		assert.ok(!isDictationProvider("openai") && !isDictationProvider(null));
		assert.equal(resolveSettings(null).dictation.provider, "deepgram");
		assert.equal(resolveSettings({ version: 1 }).dictation.provider, "deepgram");
		assert.equal(resolveSettings(null).dictation.backend, null);
		assert.deepEqual(resolveSettings(null).dictation.stream, { url: null, model: null });
	});

	it("normalizes ws stream urls: ws/wss only, no credentials/fragment, query kept, trailing slashes stripped", () => {
		assert.equal(normalizeStreamUrl("wss://stt.homelab.internal/v1/audio/stream"), "wss://stt.homelab.internal/v1/audio/stream");
		assert.equal(normalizeStreamUrl("  ws://localhost:8000/v1/audio/stream/  "), "ws://localhost:8000/v1/audio/stream");
		assert.equal(normalizeStreamUrl("wss://stt.example/stream?api_key=abc"), "wss://stt.example/stream?api_key=abc");
		for (const bad of ["http://x/stream", "https://x/stream", "wss://user:pw@x/stream", "wss://x/stream#frag", "not a url", "", "ftp://x"]) {
			assert.equal(normalizeStreamUrl(bad), "", bad);
		}
	});

	it("maps dictation languages for streaming backends (alpha-2)", () => {
		assert.equal(streamLanguage("multi"), undefined);
		assert.equal(streamLanguage("en"), "en");
		assert.equal(streamLanguage("en-GB"), "en");
		assert.equal(streamLanguage("zh-Hans"), "zh");
		assert.equal(streamLanguage("es-419"), "es");
		assert.equal(streamLanguage("pt-BR"), "pt");
	});

	it("sanitizer keeps valid provider/backend/stream and drops invalid ones", () => {
		const record = sanitizeUserSettings({ version: 1, dictation: {
			language: "pl", provider: "ws", backend: "transcribe-server",
			stream: { url: " wss://stt.homelab.internal/v1/audio/stream/ ", model: " voxtral " },
		} });
		assert.deepEqual(record?.dictation, {
			language: "pl", provider: "ws", backend: "transcribe-server",
			stream: { url: "wss://stt.homelab.internal/v1/audio/stream", model: "voxtral" },
		});
		const resolved = resolveSettings(record).dictation;
		assert.equal(resolved.provider, "ws");
		assert.equal(resolved.backend, "transcribe-server");
		assert.deepEqual(resolved.stream, { url: "wss://stt.homelab.internal/v1/audio/stream", model: "voxtral" });
		const bad = sanitizeUserSettings({ version: 1, dictation: {
			provider: "openai", backend: "bad id!", stream: { url: "http://x", model: "  " },
		} });
		assert.deepEqual(bad?.dictation, {});
		const noStream = sanitizeUserSettings({ version: 1, dictation: { provider: "ws", stream: { url: "wss://x/s" } } });
		assert.deepEqual(noStream?.dictation, { provider: "ws", stream: { url: "wss://x/s" } });
	});

	it("write side validates provider/backend/stream strictly", () => {
		assert.deepEqual(parseDictationSettingsBody({
			provider: "ws", backend: "transcribe-server", stream: { url: "wss://x/s", model: "m" },
		}), { ok: true, settings: { provider: "ws", backend: "transcribe-server", stream: { url: "wss://x/s", model: "m" } } });
		assert.deepEqual(parseDictationSettingsBody({ provider: "deepgram" }), { ok: true, settings: { provider: "deepgram" } });
		for (const body of [
			{ provider: "openai" }, { provider: 1 }, { backend: "bad id!" }, { backend: 3 },
			{ stream: "x" }, { stream: { url: "http://x" } }, { stream: { url: "wss://u:p@x/s" } },
			{ stream: { model: "" } }, { stream: { model: 5 } },
		]) {
			assert.equal(parseDictationSettingsBody(body).ok, false, JSON.stringify(body));
		}
	});
});

const testData = mkdtempSync(path.join(tmpdir(), "lh-dictation-settings-"));
process.env.LH_DATA_DIR = testData;
after(() => { rmSync(testData, { recursive: true, force: true }); });
const { readSettings, writeSettings } = await import("../src/store/settings.ts");

it("the section route persists language independently and rejects unsupported values without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1, general: { autoUpdate: false } });
	const put = (language: string) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language }),
	}), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal((await put("pl")).status, 200);
	const saved = { version: 1, dictation: { language: "pl" }, general: { autoUpdate: false } };
	assert.deepEqual(readSettings(), saved);
	assert.equal((await put("unsupported")).status, 400);
	assert.deepEqual(readSettings(), saved);
	const general = await PUT(new Request("http://localhost/api/settings/general", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoUpdate: true }),
	}), { params: Promise.resolve({ section: "general" }) });
	assert.equal(general.status, 200);
	assert.deepEqual(readSettings(), { ...saved, general: { autoUpdate: true } }, "auto-update cannot erase dictation language");
});

it("the section route persists provider/backend/stream and rejects invalid values without writing", async () => {
	const { PUT } = await import("../app/api/settings/[section]/route.ts");
	writeSettings({ version: 1 });
	const put = (body: unknown) => PUT(new Request("http://localhost/api/settings/dictation", {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "dictation" }) });
	assert.equal((await put({ language: "en", provider: "ws", backend: "transcribe-server", stream: { url: "wss://stt.homelab.internal/v1/audio/stream", model: "voxtral" } })).status, 200);
	assert.deepEqual(readSettings(), { version: 1, dictation: {
		language: "en", provider: "ws", backend: "transcribe-server",
		stream: { url: "wss://stt.homelab.internal/v1/audio/stream", model: "voxtral" },
	} });
	assert.equal((await put({ provider: "nope" })).status, 400);
	assert.equal((await put({ stream: { url: "http://x" } })).status, 400);
	assert.deepEqual(readSettings()?.dictation?.provider, "ws", "rejected writes leave the stored section unchanged");
	// replace-whole: a language-only PUT clears the provider override
	assert.equal((await put({ language: "de" })).status, 200);
	assert.deepEqual(readSettings(), { version: 1, dictation: { language: "de" } });
});
