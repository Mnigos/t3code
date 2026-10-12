// Search-path variables the AppImage runtime prepends its mount dir to.
const APPIMAGE_SEARCH_PATH_ENV_KEYS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"] as const;

// The AppImage runtime mounts the app at `$TMPDIR/.mount_<id>`. Captures that
// mount root for any segment inside it.
const APPIMAGE_MOUNT_ROOT = /^(.*?\/\.mount_[^/]+)(?:\/|$)/;

/**
 * Removes search-path segments that point into another AppImage launch's
 * `.mount_*` dir. Launching T3 Code from a terminal or agent that inherited an
 * earlier launch's env stacks every older mount onto PATH; once one of them is
 * unmounted, every spawn that walks PATH (git, shells) fails with ENOTCONN.
 * Segments under the current APPDIR stay, as do all non-mount segments.
 * Non-AppImage envs are returned as is.
 *
 * Can fold into the shared `appImageRuntimeEnv` helper once #16679 lands.
 */
export function stripStaleAppImageMounts(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_SEARCH_PATH_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    const kept = value.split(":").filter((segment) => {
      const mountRoot = APPIMAGE_MOUNT_ROOT.exec(segment)?.[1];
      return mountRoot === undefined || mountRoot === appDir;
    });
    if (kept.some((segment) => segment.length > 0)) {
      scrubbed[key] = kept.join(":");
    } else if (value.length > 0) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}

/** Applies {@link stripStaleAppImageMounts} to `env` in place. */
export function installStaleAppImageMountScrub(env: NodeJS.ProcessEnv): void {
  const scrubbed = stripStaleAppImageMounts(env);
  if (scrubbed === env) return;
  for (const key of APPIMAGE_SEARCH_PATH_ENV_KEYS) {
    const value = scrubbed[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}
