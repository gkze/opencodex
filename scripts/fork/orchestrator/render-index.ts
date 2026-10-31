import { renderIndex } from "../../structure-ssot.ts"
import { join } from "node:path"
const root = process.argv[2]
await Bun.write(join(root, "structure/INDEX.md"), renderIndex(await Bun.file(join(root, "structure/manifest.json")).json()))
