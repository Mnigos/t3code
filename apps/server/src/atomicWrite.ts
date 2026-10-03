import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      // The rename replaces the inode, so carry the target's permission bits over
      // (these files can hold secrets); new files start owner-only.
      const mode = yield* fs.stat(input.filePath).pipe(
        Effect.map((info) => info.mode & 0o777),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0o600)),
      );

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      // chmod, not a write `mode`, because the umask would mask it; the temp directory is 0700.
      yield* fs.chmod(tempPath, mode);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
