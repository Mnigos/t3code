// @effect-diagnostics nodeBuiltinImport:off - Verify observable Node filesystem contents and permissions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const makeTestDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-test-" });
});

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect.each([
    { label: "0600", mode: 0o600 },
    { label: "0644", mode: 0o644 },
    { label: "0664", mode: 0o664 },
  ])("preserves an existing $label file's mode", ({ mode }) =>
    Effect.gen(function* () {
      const dir = yield* makeTestDirectory;
      const filePath = NodePath.join(dir, "settings.json");
      NodeFS.writeFileSync(filePath, "old contents");
      NodeFS.chmodSync(filePath, mode);

      yield* writeFileStringAtomically({ filePath, contents: "new contents" });

      if (!windowsHost) {
        assert.equal(NodeFS.statSync(filePath).mode & 0o777, mode);
      }
      assert.equal(NodeFS.readFileSync(filePath, "utf8"), "new contents");
    }),
  );

  it.effect.each(["settings.json", "nested/parent/settings.json"])(
    "creates missing %s with owner-only permissions",
    (filename) =>
      Effect.gen(function* () {
        const dir = yield* makeTestDirectory;
        const filePath = NodePath.join(dir, filename);

        yield* writeFileStringAtomically({ filePath, contents: "new contents" });

        assert.equal(NodeFS.readFileSync(filePath, "utf8"), "new contents");
        if (!windowsHost) {
          assert.equal(NodeFS.statSync(filePath).mode & 0o777, 0o600);
        }
      }),
  );

  it.effect("preserves the exact UTF-8 bytes, including a trailing newline", () =>
    Effect.gen(function* () {
      const dir = yield* makeTestDirectory;
      const filePath = NodePath.join(dir, "settings.json");
      const contents = "Zażółć gęślą jaźń, 日本語, 🎵\n";

      yield* writeFileStringAtomically({ filePath, contents });

      assert.deepEqual(NodeFS.readFileSync(filePath), Buffer.from(contents, "utf8"));
    }),
  );

  it.effect("removes the temporary directory after a successful write", () =>
    Effect.gen(function* () {
      const dir = yield* makeTestDirectory;
      const filePath = NodePath.join(dir, "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: "new contents" });

      assert.deepEqual(NodeFS.readdirSync(dir), ["settings.json"]);
    }),
  );

  it.effect.skipIf(windowsHost || process.getuid?.() === 0)(
    "leaves the original file intact and no temporary directory when the parent is read-only",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTestDirectory;
        const filePath = NodePath.join(dir, "settings.json");
        NodeFS.writeFileSync(filePath, "old contents");
        NodeFS.chmodSync(filePath, 0o600);
        const parentMode = NodeFS.statSync(dir).mode & 0o777;
        NodeFS.chmodSync(dir, 0o555);

        try {
          const error = yield* writeFileStringAtomically({
            filePath,
            contents: "new contents",
          }).pipe(Effect.flip);

          assert.instanceOf(error, PlatformError.PlatformError);
          assert.equal(NodeFS.readFileSync(filePath, "utf8"), "old contents");
          assert.equal(NodeFS.statSync(filePath).mode & 0o777, 0o600);
          assert.deepEqual(NodeFS.readdirSync(dir), ["settings.json"]);
        } finally {
          NodeFS.chmodSync(dir, parentMode);
        }
      }),
  );
});
