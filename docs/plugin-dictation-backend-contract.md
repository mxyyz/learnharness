# STT backend registration contract (dictation)

Plugins register streaming speech-to-text WebSocket backends that native
dictation uses as an alternative to the built-in Deepgram provider. This page
is the normative behavior contract; the generated reference
([`PluginSttBackend`](plugin-api/plugins.md#pluginsttbackend),
[`PluginSttConnection`](plugin-api/plugins.md#pluginsttconnection),
[`PluginSttEvent`](plugin-api/plugins.md#pluginsttevent),
[`PluginFrontendContext.registerSttBackend`](plugin-api/plugins.md#pluginfrontendcontext-registersttbackend))
is the structural one.

## Registration

`context.registerSttBackend(backend)` registers one backend for the plugin's
frontend activation (once per enabled plugin per window) and returns an
unregister function. The host validates the shape (id pattern
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, non-empty label, `connect` function),
rejects duplicate ids, freezes the registration, and publishes it to the
backend registry. Registrations expire with the activation AbortSignal:
disabling, uninstalling, or reloading the plugin removes the backend, and a
dictation run using it aborts with a terminal error. The host never calls a
backend's functions after unregistration.

## The adapter contract

A backend is a pure adapter describing one server's wire protocol:

- `connect({ url, model?, language })` — called at each run start (and once per
  reconnect) with the user's stream config and the RAW dictation language code
  (`"multi"`, `"en"`, `"en-GB"`, …). Returns (sync or async) the connection:
  - `url` — the WebSocket URL to open;
  - `protocols?` — handshake subprotocols (e.g. a minted token);
  - `startFrames?` — text/binary frames sent on open, before any audio;
  - `encodeAudio(frame)` — encodes one captured PCM16LE mono 16 kHz frame for
    the socket (binary passthrough or base64-in-JSON);
  - `parseMessage(data)` — parses one server text frame into
    `{ partial?, final?, error? }` or `null` for unrecognized frames;
  - `stopFrame?` — text frame sent on stop (when null, the host closes the
    socket itself).
- Mapping the language to the backend's expected form (e.g. alpha-2, or
  omitting it for auto-detect) is the adapter's job.

## Engine integration (host-owned)

- The dictation engine resolves the configured backend id in the live registry
  at run start; an unregistered id fails honestly before the mic opens, naming
  the backend. The Settings → Dictation backend dropdown lists registered
  backends live and marks a stored-but-unregistered id as missing.
- The engine sends start frames on open, streams `encodeAudio` output in
  capture order (frames captured before OPEN are queued and flushed in order),
  routes server text messages through `parseMessage`, and sends `stopFrame` on
  stop. Partial events are not displayed; the final event's text is appended
  once when the run ends (deferred transcript UX, identical to Deepgram).
- Abnormal closes reconnect once with a fresh `connect`; a second drop ends the
  run with a terminal error. An `error` event ends the run with that message.
  All adapter calls are wrapped: a throw becomes a terminal dictation error.
- The renderer connects directly to the backend URL (keyless by default; no
  app-server proxy). If a backend needs handshake credentials, `connect`
  supplies them via `protocols` or the URL.

## Reference example

The `transcribe-server-stt` plugin (maintained in its own repository,
`lh_transcribe-server_plugin`, installed like any external plugin) registers
the `transcribe-server` backend for a self-hosted
[transcribe-server](https://github.com/shaba/transcribe-server)
(`wss://host/v1/audio/stream`: start frame, PCM16LE passthrough, stop frame,
partial/final/error events). Plugins ship disabled until the user enables
them.
