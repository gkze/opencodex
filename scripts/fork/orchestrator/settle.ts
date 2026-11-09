/** What a worker's outcome means for one patch tonight.
 *
 * - accept: ship the worker's candidate.
 * - propose: a sensitive patch was reworked by the repair agent. Nothing a model wrote into a
 *   sensitive patch ships without a person, so the rework goes to `review/<id>` and the patch is
 *   held. The person then reviews a finished rework instead of writing one.
 * - hold: ship the revision the last accepted stack published. One blocked patch costs that patch
 *   a night, not the whole refresh. That includes a worker result the coordinator rejects: the held
 *   revision comes from the fork branch, never from the rejected artifact.
 */
export type Outcome =
  | {readonly kind: "unfinished", readonly failure: string}
  | {readonly kind: "rejected", readonly failure: string}
  | {readonly kind: "verified", readonly adapted: boolean}
export type Settlement = {readonly action: "accept"} | {readonly action: "propose" | "hold", readonly reason: string}

export const reviewBranch = (id: string) => `review/${id}`

export const settle = (sensitive: boolean, id: string, outcome: Outcome): Settlement => {
  if (outcome.kind === "unfinished") return {action: "hold", reason: `worker did not finish: ${outcome.failure}`}
  if (outcome.kind === "rejected") return {action: "hold", reason: `worker result rejected: ${outcome.failure}`}
  if (sensitive && outcome.adapted) return {action: "propose", reason: `sensitive patch needs review; the proposed rework is on ${reviewBranch(id)}`}
  return {action: "accept"}
}

/** A GitHub Actions workflow command. Properties and the message are escaped as the runner requires. */
export const annotation = (level: "error" | "warning" | "notice", title: string, message: string) => {
  const data = (value: string) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
  const property = (value: string) => data(value).replaceAll(":", "%3A").replaceAll(",", "%2C")
  return `::${level} title=${property(title)}::${data(message)}`
}
