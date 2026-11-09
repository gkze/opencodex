# fx Client Integration

fx follows the shared [client-integration ownership contract](integrations.md); this page records only what is specific to it.

## fx custom connections

`src/clients/config-export/fx.ts` owns one top-level `providers.opencodex` entry in
`~/.fx/settings.json`, and nothing else: fx defines a custom connection only in that private
profile, so a workspace `<project>/.fx.json` — which cannot declare or select one — is never a
target. The entry is `openai-chat-completions` against the proxy's `/v1` root, because fx appends
`/chat/completions` itself, and its `model_metadata` map doubles as fx's model list, so only the
declared capabilities are written: a context window where the catalog has one, image input where
the model declares it, and no output limit at all.

The client is loopback-only for the reason Raycast and DSH are: fx sends no custom authentication
header, and `/v1/chat/completions` rejects a bearer credential while requiring the dedicated
`x-opencodex-api-key` header. A non-loopback bind is refused rather than written as a connection
that cannot authenticate. Selection is user-owned — `fx provider opencodex` moves it — and fx's
64 KiB settings-file limit is shared with the rest of the operator's profile, so the generated
fragment stays to the fields above.
