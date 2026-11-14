import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The per-user state directory: `$XDG_STATE_HOME/kestrel` (or `~/.local/state/kestrel`) on Linux, `~/Library/Application Support/kestrel` on macOS. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "kestrel");
  const base = env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(base, "kestrel");
}

/** A run's private working directory (mode 0700), removed by {@link Workspace.dispose} unless the run keeps it. */
export interface Workspace {
  dir: string;
  path(name: string): string;
  dispose(): void;
}

/** Creates `runs/<runId>` below `root` with mode 0700. */
export function createWorkspace(root: string, runId: string, keep = false): Workspace {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    path: (name) => join(dir, name),
    dispose: () => {
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}
