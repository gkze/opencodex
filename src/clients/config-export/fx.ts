import { homedir } from "node:os";
import { join } from "node:path";
import { OPENCODE_PROVIDER_ID } from "./constants";
import type { ExportContext, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { authoritativeContextWindow, normalizeExportModels, singleFragment } from "./model-metadata";

/**
 * fx publishes no setting that relocates its profile: the environment table in
 * fx.sh/docs/configure-fx/configuration lists FX_PROVIDER, FX_MODEL, FX_THEME and
 * the debug knobs, but nothing like CLINE_DIR or OPENCLAW_STATE_DIR. So the
 * profile is the fixed `~/.fx`, and `_env` exists only to keep the registry's
 * uniform `configPath(env, home)` signature honest — the same shape Raycast has.
 */
export function fxSettingsDir(_env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(home, ".fx");
}

/**
 * fx's private profile, and the only file that may define a custom connection: a
 * workspace `<project>/.fx.json` is limited to the project fields and cannot
 * declare or select one.
 */
export function fxConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(fxSettingsDir(env, home), "settings.json");
}

/**
 * fx custom model connection, per fx.sh/docs/configure-fx/custom-model-connections.
 *
 * fx defines a custom connection only at the TOP LEVEL of `~/.fx/settings.json`;
 * a workspace `<project>/.fx.json` cannot define or select one. That is why the
 * managed fragment is `providers.opencodex` and nothing else — the same file also
 * holds the user's theme, workspaces and permission rules, and the selection
 * (`provider`, `models`) belongs to the operator, who moves it with
 * `fx provider opencodex`.
 */
export interface FxConnection {
  protocol: "openai-chat-completions";
  /** fx appends `/chat/completions`, so the proxy's `/v1` root passes through. */
  base_url: string;
  /**
   * fx offers `{"type":"none"}` and bearer-from-environment only, and its adapter
   * sends no custom header. `/v1/chat/completions` rejects a bearer credential and
   * requires the dedicated `x-opencodex-api-key` header (AUTH_MATRIX in
   * src/server/auth-cors.ts), so a remote bind has nowhere to put its admission —
   * the registry marks this client loopback-only rather than emitting a config
   * that 401s, exactly as Raycast and DSH do.
   */
  auth: { type: "none" };
  /**
   * fx's model list: `fx models` prints exactly these keys, and there is no
   * separate catalog endpoint for a custom connection.
   */
  model_metadata: Record<string, FxModelMetadata>;
}

export interface FxModelMetadata {
  /** Automatic compaction reads this; absent means fx cannot compute a threshold. */
  context_window?: number;
  /**
   * Declared image input, and only that. fx gates image attachments on this field
   * and treats absence as its own "no vision" default, so a model that declares
   * nothing gets no key rather than a `false` we cannot source.
   */
  supports_vision?: true;
  /**
   * Existing client-export convention, not a verified per-model capability:
   * ExportModel has no authoritative tool-support field. Same call, and the same
   * reason, as `abilities.tools` in ./raycast.ts.
   */
  supports_tool_use: true;
}

export interface FxGeneratedConfig {
  providers: Record<string, FxConnection>;
}

/**
 * `max_output_tokens` is deliberately absent. fx treats it as optional, and the
 * only output figure this project owns is the schema-validity ceiling in
 * SCHEMA_REQUIRED_OUTPUT_BUDGET — a stand-in for clients whose schema *requires*
 * the output half (opencode) or whose contract pairs the two (Pi's `maxTokens`).
 * Emitting it here would spend bytes against fx's 64 KiB settings-file limit on a
 * number that is not a claim about any model.
 */
export function buildFxClientConfig(ctx: ExportContext): FxGeneratedConfig {
  const model_metadata: Record<string, FxModelMetadata> = {};
  for (const model of normalizeExportModels(ctx.models)) {
    const contextWindow = authoritativeContextWindow(model.contextWindow);
    model_metadata[model.namespaced] = {
      ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
      ...(model.inputModalities?.includes("image") ? { supports_vision: true as const } : {}),
      supports_tool_use: true,
    };
  }
  return {
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        protocol: "openai-chat-completions",
        base_url: ctx.baseUrl,
        auth: { type: "none" },
        model_metadata,
      },
    },
  };
}

export function summarizeFx(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const metadata = (document as FxGeneratedConfig | undefined)?.providers?.[OPENCODE_PROVIDER_ID]?.model_metadata;
  const models = Object.values(metadata && typeof metadata === "object" ? metadata : {});
  return {
    modelCount: models.length,
    modelsWithoutLimits: models.filter(model => model.context_window === undefined).length,
  };
}

export function buildFxContribution(ctx: ExportContext): ManagedContribution {
  const doc = buildFxClientConfig(ctx);
  return singleFragment("fx", ["providers", OPENCODE_PROVIDER_ID], doc.providers[OPENCODE_PROVIDER_ID]);
}
