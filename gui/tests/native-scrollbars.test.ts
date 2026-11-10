/**
 * Scrollbars stay native so macOS can hide them when idle and honor the user's Show scroll bars
 * preference. A global `*::-webkit-scrollbar` or `scrollbar-width` rule takes that away from the
 * OS. Only the quota strip hides its own horizontal scrollbar, because it pages with buttons.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src", import.meta.url).pathname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

test("no stylesheet paints scrollbars globally", () => {
  const offenders: string[] = [];
  for (const file of cssFiles(root)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/(^|[\s,}])(\*|html|body|:root)(:[\w-]+)*::-webkit-scrollbar/m.test(css)) offenders.push(`${file}: global ::-webkit-scrollbar`);
    if (/(^|[\s,{}])(\*|html|body|:root)\s*\{[^}]*scrollbar-(width|color)\s*:/m.test(css)) offenders.push(`${file}: global scrollbar-width/color`);
  }
  expect(offenders).toEqual([]);
});
