import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  EXPORT_CLIENTS,
  fxConfigPath,
  fxSettingsDir,
  type ExportContext,
} from "../../src/clients/config-export";
import type { FxGeneratedConfig } from "../../src/clients/config-export/fx";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";

/**
 * Oracle: fx.sh/docs/configure-fx/custom-model-connections and .../configuration
 * (read 2026-09-30). A custom connection lives at the TOP LEVEL of
 * `~/.fx/settings.json`, is `openai-chat-completions` only, and cannot be
 * defined in a workspace `.fx.json`.
 */
const context: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1",
  models: [
    { namespaced: "mock/vision", provider: "mock", id: "vision", contextWindow: 200000, inputModalities: ["text", "image"] },
    { namespaced: "mock/unknown", provider: "mock", id: "unknown" },
    // fx has no modality enum, so unlike Pi and Gajae an audio-only row is still
    // selectable: it simply declares no vision.
    { namespaced: "mock/audio", provider: "mock", id: "audio", inputModalities: ["audio"] },
    { namespaced: "mock/vision", provider: "mock", id: "duplicate", contextWindow: 1 },
  ],
};

describe("fx custom connection contract", () => {
  test("emits one top-level connection with canonical selectors and no invented limits", () => {
    const doc = buildClientConfig("fx", context) as FxGeneratedConfig;
    expect(Object.keys(doc)).toEqual(["providers"]);
    expect(doc.providers.opencodex).toEqual({
      protocol: "openai-chat-completions",
      base_url: context.baseUrl,
      auth: { type: "none" },
      model_metadata: {
        "mock/audio": { supports_tool_use: true },
        "mock/unknown": { supports_tool_use: true },
        "mock/vision": { context_window: 200000, supports_vision: true, supports_tool_use: true },
      },
    });
    // No `provider` and no `models`: the selection belongs to the operator, who
    // moves it with `fx provider opencodex`.
    expect(doc).not.toHaveProperty("provider");
    expect(doc).not.toHaveProperty("models");
    expect(JSON.parse(buildClientConfigText("fx", context).text)).toEqual(doc);
    expect(EXPORT_CLIENTS.fx.summarize(doc)).toEqual({ modelCount: 3, modelsWithoutLimits: 2 });
  });

  test("owns exactly the connection and refuses a remote bind", () => {
    expect(buildClientContribution("fx", context).fragments.map(f => f.path)).toEqual([
      ["providers", "opencodex"],
    ]);
    /*
     * fx sends no custom header, and /v1/chat/completions rejects a bearer
     * credential while requiring the dedicated x-opencodex-api-key header, so
     * there is nowhere to put a remote bind's admission.
     */
    expect(EXPORT_CLIENTS.fx.loopbackOnly).toBe(true);
    expect(buildClientConfigText("fx", context).format).toBe("json");
    expect(EXPORT_CLIENTS.fx.apiKeyEnv).toBe("");
  });

  test("the profile is a fixed path: fx publishes no relocation setting", () => {
    const home = join(process.cwd(), "synthetic-home");
    expect(fxConfigPath({}, home)).toBe(join(home, ".fx", "settings.json"));
    expect(fxSettingsDir({}, home)).toBe(join(home, ".fx"));
    // An unrelated override must not move it, and neither must FX_PROVIDER,
    // which selects a connection rather than relocating the profile.
    expect(fxConfigPath({ FX_PROVIDER: "gateway", XDG_CONFIG_HOME: "~/elsewhere" }, home))
      .toBe(join(home, ".fx", "settings.json"));
    expect(INTEGRATION_CLIENTS.fx.configPath({}, home)).toBe(join(home, ".fx", "settings.json"));
    expect(INTEGRATION_CLIENTS.fx.detectDir({}, home)).toBe(join(home, ".fx"));
  });
});
