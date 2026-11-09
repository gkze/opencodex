import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// The caller supplies the trusted build inventory, never one derived from downloaded metadata.
export function verifyAssets(directory, { version, source }, inventory) {
  const names = [];
  assert.deepEqual(readdirSync(directory).sort(), inventory.map(item => item.artifact).sort(), 'Unexpected build artifacts');
  for (const { target, files, artifact } of inventory) {
    const artifactDirectory = path.join(directory, artifact);
    const metadataName = `assets-${target}.json`;
    const metadata = JSON.parse(readFileSync(path.join(artifactDirectory, metadataName), 'utf8'));
    assert.equal(metadata.version, version, `Version mismatch: ${target}`);
    assert.equal(metadata.source, source, `Source mismatch: ${target}`);
    assert.equal(metadata.target, target);
    assert.ok(Array.isArray(metadata.files));
    assert.deepEqual(metadata.files.map(file => file.name).sort(), [...files].sort(), `Incomplete build: ${target}`);
    for (const file of metadata.files) {
      assert.equal(path.basename(file.name), file.name);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(createHash('sha256').update(readFileSync(path.join(artifactDirectory, file.name))).digest('hex'), file.sha256, `Corrupt asset: ${file.name}`);
      assert.equal(readFileSync(path.join(artifactDirectory, `${file.name}.sha256`), 'utf8'), `${file.sha256}  ${file.name}\n`, 'Checksum sidecar differs');
      names.push({ name: file.name, path: path.join(artifactDirectory, file.name) });
    }
    assert.deepEqual(readdirSync(artifactDirectory).sort(), [metadataName, ...files.flatMap(name => [name, `${name}.sha256`])].sort(), `Unexpected files in ${artifact}`);
    names.push({ name: metadataName, path: path.join(artifactDirectory, metadataName) });
  }
  assert.equal(names.length, new Set(names.map(file => file.name)).size, 'Duplicate release assets');
  return names;
}
