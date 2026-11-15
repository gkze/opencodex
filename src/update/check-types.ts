import type { Channel, Installer, InstallOwnership } from "./index";

export interface UpdateCheckDeps {
  currentVersion: () => string;
  detectInstall: () => Installer;
  detectInstallOwnership?: () => InstallOwnership;
  latestVersion: (tag: Channel) => string | null;
  miseUpdateCommand?: (ownership: InstallOwnership) => string | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}
