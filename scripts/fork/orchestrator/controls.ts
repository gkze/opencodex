/** Fork-owned control paths. A repair agent never writes these, whatever the patch touches. */
export const forkControls = [".github", "scripts/fork", "package.json", "bun.lock"] as const

export const isForkControl = (path: string) => forkControls.some(control => path === control || path.startsWith(`${control}/`))
