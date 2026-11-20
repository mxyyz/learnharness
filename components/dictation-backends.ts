"use client";

/**
 * The streaming STT backend registry (add-openai-compatible-stt-provider).
 *
 * Plugins register WebSocket speech-to-text backends through
 * `PluginFrontendContext.registerSttBackend` (see src/core/plugins.ts);
 * the plugin frontend manager forwards each registration here. The registry
 * is module-level and window-scoped: registrations expire with their plugin's
 * activation, and subscribers (the dictation engine at run start, the
 * Settings → Dictation backend dropdown) observe the live list via
 * subscribe/getSnapshot — enabling or disabling a plugin is reflected without
 * a reload.
 *
 * The registry only stores and validates; it never calls backend code. The
 * dictation engine resolves a backend at run start and wraps every adapter
 * call so a throwing/misbehaving adapter becomes a terminal dictation error.
 */
import {
	STT_BACKEND_ID_PATTERN,
	type PluginSttBackend,
	type PluginSttConnection,
} from "@/src/core";

export interface SttBackendRegistration {
	readonly pluginId: string;
	readonly backend: PluginSttBackend;
}

const backends = new Map<string, SttBackendRegistration>();
const listeners = new Set<() => void>();

let snapshot: readonly SttBackendRegistration[] = Object.freeze([]);

function publish() {
	snapshot = Object.freeze([...backends.values()]);
	for (const listener of [...listeners]) listener();
}

/** Subscribe to registry changes; returns unsubscribe. */
export function subscribeSttBackends(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Current registrations (frozen snapshot), for useSyncExternalStore. */
export function getSttBackendsSnapshot(): readonly SttBackendRegistration[] {
	return snapshot;
}

/** Look up one backend by id. */
export function getSttBackend(id: string): SttBackendRegistration | undefined {
	return backends.get(id);
}

/** Validate a plugin-supplied backend object; throws on malformed input.
 * Connection-level functions are validated when `connect` returns (see
 * validateSttConnection) because the connection only exists at run start. */
export function validateSttBackend(value: unknown): PluginSttBackend {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("STT backend must be an object");
	const b = value as Record<string, unknown>;
	if (typeof b.id !== "string" || !STT_BACKEND_ID_PATTERN.test(b.id)) {
		throw new Error("STT backend id must be a route-safe string of 1–128 characters, starting with a letter or number");
	}
	if (typeof b.label !== "string" || !b.label.trim()) throw new Error("STT backend label must be a nonempty string");
	if (b.description !== undefined && typeof b.description !== "string") throw new Error("STT backend description must be a string");
	if (typeof b.connect !== "function") throw new Error("STT backend connect must be a function");
	return value as PluginSttBackend;
}

/** Validate the connection object a backend's `connect` returned; throws. */
export function validateSttConnection(value: unknown): PluginSttConnection {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("STT backend connect must return a connection object");
	const c = value as Record<string, unknown>;
	if (typeof c.url !== "string" || !c.url.trim()) throw new Error("STT connection url must be a nonempty string");
	if (c.protocols !== undefined && (!Array.isArray(c.protocols) || c.protocols.some(p => typeof p !== "string"))) throw new Error("STT connection protocols must be strings");
	if (c.startFrames !== undefined && (!Array.isArray(c.startFrames) || c.startFrames.some(f => typeof f !== "string" && !(f instanceof ArrayBuffer) && !ArrayBuffer.isView(f)))) throw new Error("STT connection startFrames must be strings or binary");
	if (typeof c.encodeAudio !== "function") throw new Error("STT connection encodeAudio must be a function");
	if (typeof c.parseMessage !== "function") throw new Error("STT connection parseMessage must be a function");
	if (c.stopFrame !== undefined && c.stopFrame !== null && typeof c.stopFrame !== "string") throw new Error("STT connection stopFrame must be a string or null");
	return value as PluginSttConnection;
}

/** Host-side registration (called by the plugin frontend manager). Validates,
 * rejects duplicates, freezes/binds, publishes. Returns unregister. */
export function registerSttBackend(pluginId: string, raw: unknown): () => void {
	const backend = validateSttBackend(raw);
	if (backends.has(backend.id)) throw new Error(`Duplicate STT backend registration: ${backend.id}`);
	// Freeze the shell and bind connect so later plugin-side mutation or
	// receiver loss cannot affect the host (same pattern as renderers).
	const owned = Object.freeze({
		id: backend.id,
		label: backend.label,
		...(backend.description !== undefined ? { description: backend.description } : {}),
		connect: backend.connect.bind(backend),
	});
	const registration: SttBackendRegistration = Object.freeze({ pluginId, backend: owned });
	backends.set(owned.id, registration);
	publish();
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		if (backends.get(owned.id) === registration) {
			backends.delete(owned.id);
			publish();
		}
	};
}
