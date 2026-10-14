import { expect, test } from "bun:test";
import { applyConfigHintsToCachedModels } from "../../src/codex/catalog/model-hints";
import { applyCatalogModelMetadata } from "../../src/codex/catalog/effort";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: "https://gateway.invalid/v1", supportsServiceTier: true,
  supportsUltraFast: true,
  fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", ultrafast: "ultrafast" }, foreignCallerTiers: "verbatim" },
};
for (const override of [{ supportsUltraFast: false }, { modelSupportsUltraFast: { "task-model": false } }, { fastEnabled: false }]) {
  test(`cached Ultra Fast evidence is withdrawn by ${JSON.stringify(override)}`, () => {
    const cached = applyConfigHintsToCachedModels("gateway", provider, [{ provider: "gateway", id: "task-model" }]);
    expect(cached[0]?.supportsUltraFast).toBe(true);
    const refreshed = applyConfigHintsToCachedModels("gateway", { ...provider, ...override }, cached);
    expect(refreshed[0]?.supportsUltraFast).not.toBe(true);
    const row: RawEntry = { slug: "gateway/task-model" };
    applyCatalogModelMetadata(row, refreshed[0]);
    expect(row.additional_speed_tiers ?? []).not.toContain("ultrafast");
    expect(cached[0]?.supportsUltraFast).toBe(true);
  });
}
