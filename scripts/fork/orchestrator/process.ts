import { Effect } from "effect"
export const command = (argv: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env, options: {trimOutput?: boolean} = {}) => Effect.tryPromise({
  try: async signal => {
    const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
    const abort = () => child.kill("SIGTERM")
    signal.addEventListener("abort", abort, { once: true })
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (status !== 0) throw new Error(`${argv.join(" ")} exited ${status} in ${cwd}: ${stderr.slice(-4000)}`)
      return options.trimOutput === false ? stdout : stdout.trim()
    } finally { signal.removeEventListener("abort", abort) }
  }, catch: error => String(error),
})
export const git = (cwd: string, ...args: string[]) => command(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd, args[0] === "push" && process.env.FORK_PUSH_TOKEN ? {...process.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.FORK_PUSH_TOKEN}`).toString("base64")}`} : process.env)

/** Like `command`, but returns the exit status and both streams instead of throwing.
 * `git diff --check` reports whitespace errors on stdout with exit status 2, so a throwing
 * wrapper can only ever say "exited 2" and loses the lines that identify the problem. */
export const commandResult = (argv: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env) => Effect.tryPromise({
  try: async signal => {
    const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
    const abort = () => child.kill("SIGTERM")
    signal.addEventListener("abort", abort, { once: true })
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { status, stdout: stdout.trim(), stderr: stderr.trim() }
    } finally { signal.removeEventListener("abort", abort) }
  }, catch: error => String(error),
})
