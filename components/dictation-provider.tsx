"use client";

import { useSyncExternalStore } from "react";
import { DICTATION_PROVIDERS, type DictationProvider } from "@/src/core";
import { SettingsRow, ThinSelect, CommitInput } from "@/components/settings/controls";
import { Hint } from "@/components/ui/hint";
import { useDictationLanguage } from "@/components/dictation-preference";
import { useDictationActive } from "@/components/dictation-state";
import { getSttBackendsSnapshot, subscribeSttBackends } from "@/components/dictation-backends";

const PROVIDER_LABELS: Record<DictationProvider, string> = {
	deepgram: "Deepgram (cloud)",
	ws: "Self-hosted (WebSocket)",
};

/**
 * Settings → Dictation provider controls: the STT provider picker plus, when
 * the "ws" provider is active, the plugin-registered backend dropdown and the
 * non-secret stream config (URL + model). All rows lock while a dictation run
 * is active, exactly like the language row.
 */
export function DictationProviderSetting() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const backends = useSyncExternalStore(subscribeSttBackends, getSttBackendsSnapshot, () => getSttBackendsSnapshot());
	const section = preference.section;
	const provider: DictationProvider = section?.provider ?? "deepgram";
	const backend = section?.backend ?? "";
	const url = section?.stream?.url ?? "";
	const model = section?.stream?.model ?? "";
	const disabled = active || preference.saving || section === undefined;

	const commit = (patch: Parameters<typeof preference.update>[0]) => preference.update(patch);

	return <>
		<SettingsRow label="Provider" testid="row-dictation-provider" dimmed={active}>
			<Hint label={preference.error ?? `Dictation provider: ${PROVIDER_LABELS[provider]}`} side="top">
				<ThinSelect
					value={provider}
					ariaLabel="Dictation provider"
					testid="dictation-provider"
					disabled={disabled}
					onChange={(next) => { void commit({ provider: next as DictationProvider }); }}
				>
					{DICTATION_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
				</ThinSelect>
			</Hint>
		</SettingsRow>
		{provider === "ws" && <>
			<SettingsRow label="Backend" testid="row-dictation-backend" dimmed={active}>
				<ThinSelect
					value={backend}
					ariaLabel="Dictation backend"
					testid="dictation-backend"
					disabled={disabled}
					onChange={(next) => { void commit({ backend: next }); }}
				>
					{backend === "" && <option value="">— choose —</option>}
					{backends.map((registration) => (
						<option key={registration.backend.id} value={registration.backend.id}>
							{registration.backend.label} ({registration.backend.id})
						</option>
					))}
					{backend !== "" && !backends.some((registration) => registration.backend.id === backend) && (
						<option value={backend}>{backend} (missing — enable its plugin)</option>
					)}
				</ThinSelect>
			</SettingsRow>
			<SettingsRow label="Stream URL" testid="row-dictation-stream-url" dimmed={active}>
				<CommitInput
					value={url}
					placeholder="wss://stt.homelab.internal/v1/audio/stream"
					ariaLabel="Dictation stream URL"
					testid="dictation-stream-url"
					disabled={disabled}
					onCommit={(next) => commit({ stream: { ...(next ? { url: next } : {}), ...(model ? { model } : {}) } })}
				/>
			</SettingsRow>
			<SettingsRow label="Model" testid="row-dictation-stream-model" dimmed={active}>
				<CommitInput
					value={model}
					placeholder="default model"
					ariaLabel="Dictation stream model"
					testid="dictation-stream-model"
					disabled={disabled}
					onCommit={(next) => commit({ stream: { ...(url ? { url } : {}), ...(next ? { model: next } : {}) } })}
				/>
			</SettingsRow>
		</>}
	</>;
}
