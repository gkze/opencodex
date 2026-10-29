import { expect, test } from "bun:test";
import { projectHomeCodexSettings, parseHomeCodexSettingsDocument, overlayHomeCodexSettings } from "../../src/link/codex-settings";
import { ensureFastModeFeature, fastModeFeatureFlag } from "../../src/codex/inject/config-toml";
import type { OcxConfig } from "../../src/types";

for (const demand of [true, false, undefined, "ultrafast"] as const) {
  test(`Home ${demand ?? "unset"} projects the same feature flag locally and on its Child`, () => {
    const home: OcxConfig = { port: 10100, defaultProvider: "openai", providers: {}, fastMode: demand };
    const projected = projectHomeCodexSettings(home, "test");
    const parsed = parseHomeCodexSettingsDocument(projected);
    expect(parsed).not.toBeNull();
    expect(parsed!.settings.fastMode).toBe(fastModeFeatureFlag(demand) ?? null);
    const child = overlayHomeCodexSettings({ ...home, fastMode: false }, parsed!.settings);
    const initial = "[features]\nfast_mode = false\n";
    expect(ensureFastModeFeature(initial, fastModeFeatureFlag(child.fastMode)))
      .toBe(ensureFastModeFeature(initial, fastModeFeatureFlag(home.fastMode)));
  });
}
