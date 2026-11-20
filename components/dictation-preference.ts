"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationLanguage, sanitizeUserSettings,
	type DictationLanguage, type DictationSettings, type EffectiveDictation, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	/** The raw dictation delta record (absent keys = factory defaults). */
	section: undefined as DictationSettings | undefined,
	saving: false,
	error: null as string | null,
};

/** One confirmed preference section and one write in flight, shared by every
 * surface. The factory keeps transport tests isolated without a second
 * persistence path. Section writes are replace-whole (PUT
 * /api/settings/dictation), so a save merges the confirmed snapshot with the
 * patch — a partial PUT would drop the other dictation fields.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<DictationLanguage> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				const section = record?.dictation ?? {};
				const language = section.language ?? FACTORY_SETTINGS.dictation.language;
				needsRead = false;
				publish({ language, section, error: null });
				return language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	/** Replace-whole section write merged over the confirmed snapshot. */
	function update(patch: Partial<DictationSettings>): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.section === undefined) return Promise.resolve(false);
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const body = { ...snapshot.section, ...patch };
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) throw new Error();
				const resp = await res.json() as { settings: UserSettings };
				const confirmed = sanitizeUserSettings(resp.settings)?.dictation;
				if (!confirmed || typeof confirmed !== "object") throw new Error();
				needsRead = false;
				publish({
					section: confirmed,
					language: confirmed.language ?? FACTORY_SETTINGS.dictation.language,
					error: null,
				});
				saved();
				return true;
			} catch {
				publish({ error: "Could not save dictation settings. Try again." });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	function save(language: DictationLanguage): Promise<boolean> {
		return update({ language });
	}

	async function waitReady(): Promise<void> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.section === undefined) await load();
			else return;
		}
	}

	async function getLanguage(): Promise<DictationLanguage> {
		await waitReady();
		return snapshot.language ?? FACTORY_SETTINGS.dictation.language;
	}

	/** The concrete dictation config (factory defaults applied), for run start. */
	async function getEffective(): Promise<EffectiveDictation> {
		await waitReady();
		const section = snapshot.section ?? {};
		return {
			language: section.language ?? FACTORY_SETTINGS.dictation.language,
			provider: section.provider ?? FACTORY_SETTINGS.dictation.provider,
			backend: section.backend ?? null,
			stream: {
				url: section.stream?.url ?? null,
				model: section.stream?.model ?? null,
			},
		};
	}

	return {
		load, save, update, getLanguage, getEffective,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, update: store.update, getLanguage: store.getLanguage, getEffective: store.getEffective };
}
