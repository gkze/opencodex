import { expect, test } from "bun:test";
import { projectHomeCodexSettings, parseHomeCodexSettingsDocument, overlayHomeCodexSettings } from "../../src/link/codex-settings";
import { ensureFastModeFeature } from "../../src/codex/inject/config-toml";
import { fastModeFeatureFlag } from "../../src/types/fast-mode";
import type { OcxConfig } from "../../src/types";

// The Codex feature is a boolean: Ultra Fast still means "the fast lane is on".
const EXPECTED_FLAG = [[true, true], [false, false], [undefined, null], ["ultrafast", true]] as const;

for (const [demand, flag] of EXPECTED_FLAG) {
  test(`Home ${demand ?? "unset"} projects the same feature flag locally and on its Child`, () => {
    const home: OcxConfig = { port: 10100, defaultProvider: "openai", providers: {}, fastMode: demand };
    const projected = projectHomeCodexSettings(home, "test");
    const parsed = parseHomeCodexSettingsDocument(projected);
    expect(parsed).not.toBeNull();
    expect(parsed!.settings.fastMode).toBe(flag);
    const child = overlayHomeCodexSettings({ ...home, fastMode: false }, parsed!.settings);
    const initial = "[features]\nfast_mode = false\n";
    expect(ensureFastModeFeature(initial, fastModeFeatureFlag(child.fastMode)))
      .toBe(ensureFastModeFeature(initial, fastModeFeatureFlag(home.fastMode)));
  });
}
