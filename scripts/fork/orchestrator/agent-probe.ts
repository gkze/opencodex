import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repair } from "./agent.ts"
const root = mkdtempSync(join(tmpdir(), "fork-agent-probe-"))
try {
  writeFileSync(join(root,"fixture.txt"), "broken\n")
  await Effect.runPromise(repair(root, {id:"agent-probe",branch:"codex/patch/agent-probe",requires:[],sensitive:false,runner:"ubuntu-24.04",tests:[]}, "Use write_source to replace fixture.txt with exactly repaired followed by a newline.", "You are testing a bounded file repair protocol. Follow the requested edit exactly. Only use the supplied file tools.", ["fixture.txt"], ["fixture.txt"]))
  if (readFileSync(join(root,"fixture.txt"),"utf8") !== "repaired\n") throw new Error("Agent did not perform the requested real file operation")
  console.log("Copilot SDK real file operation verified under Bun")
} finally {rmSync(root,{recursive:true,force:true})}
