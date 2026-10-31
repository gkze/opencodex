/** Fork artifacts are replaced explicitly from the fork release channel. */
export const forkReleaseUrl = "https://github.com/gkze/opencodex/releases";
export const forkUpdateMessage = `This is an OpenCodex fork build. Install a newer package from ${forkReleaseUrl}`;
export const isForkVersion = version => /^\d+\.\d+\.\d+-gkze\./.test(version);
