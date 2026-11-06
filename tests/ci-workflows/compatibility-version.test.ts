import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompatibilityVersionManifest } from "../../scripts/generate-compatibility-version";

describe("Compatibility Lab generated implementation identity", () => {
  test("manifest covers exact tracked source authority without self-reference", () => {
    const manifest = buildCompatibilityVersionManifest(process.cwd());
    const paths = manifest.files.map(row => row.path);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.assertionDslVersion).toBe("1.0.0");
    expect(manifest.evidenceSchemaVersion).toBe("1.0.0");
    expect(manifest.bunRuntimeVersion).toBe(Bun.version);
    expect(paths).toContain("package.json");
    expect(paths).toContain("bun.lock");
    expect(paths).toContain("scripts/model-metadata.source.json");
    expect(paths).toContain("src/routing/compatibility/version.ts");
    expect(paths).not.toContain("src/generated/compatibility-version.json");
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    for (const row of manifest.files) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

function archiveFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ocx-source-archive-"));
  try {
    mkdirSync(join(root, "src/generated"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    for (const path of ["package.json", "bun.lock", "scripts/model-metadata.source.json", "src/index.ts"]) {
      writeFileSync(join(root, path), "fixture");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("source archive package identity", () => {
  test("hashes source changes and excludes generated identity on repeated builds", () => {
    archiveFixture(root => {
      const before = buildCompatibilityVersionManifest(root);
      writeFileSync(join(root, "src/generated/compatibility-version.json"), "old manifest");
      expect(buildCompatibilityVersionManifest(root)).toEqual(before);
      writeFileSync(join(root, "src/index.ts"), "changed source");
      const after = buildCompatibilityVersionManifest(root);
      expect(after.files.map(row => row.path)).toEqual(before.files.map(row => row.path));
      expect(after.files.find(row => row.path === "src/index.ts")?.sha256)
        .not.toBe(before.files.find(row => row.path === "src/index.ts")?.sha256);
    });
  });

  test("rejects missing authority and source symlinks", () => {
    archiveFixture(root => {
      rmSync(join(root, "bun.lock"));
      expect(() => buildCompatibilityVersionManifest(root)).toThrow();
      writeFileSync(join(root, "bun.lock"), "fixture");
      symlinkSync(join(root, "package.json"), join(root, "src/escape.ts"));
      expect(() => buildCompatibilityVersionManifest(root)).toThrow("symbolic link");
    });
  });

  test("does not fall back from a broken checkout to archive scanning", () => {
    archiveFixture(root => {
      writeFileSync(join(root, ".git"), "gitdir: missing-checkout");
      expect(() => buildCompatibilityVersionManifest(root)).toThrow();
    });
  });
});
