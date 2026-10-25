/** Puts a snapshot on the macOS pasteboard exactly as the extension does, for a manual ⌘V. */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export class ClipboardError extends Schema.TaggedError<ClipboardError>()(
  "Clipboard.ClipboardError",
  {
    message: Schema.String,
  },
) {}

/** JXA: read the file at argv[0] and publish it as HTML on the general pasteboard. */
const script = `
ObjC.import("AppKit");
function run(argv) {
  const html = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  pasteboard.setStringForType(html, "public.html");
}`;

export const write = Effect.fn("Clipboard.write")(
  function* (html: string) {
    if (process.platform !== "darwin") {
      return yield* new ClipboardError({ message: "--clipboard is only supported on macOS" });
    }

    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const file = yield* fs.makeTempFileScoped({ suffix: ".html" });
    // The extension wraps its payload in <x-paper-html>; Paper keys snapshot paste on it.
    yield* fs.writeFileString(file, `<x-paper-html>${html}</x-paper-html>`);

    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("osascript", ["-l", "JavaScript", "-e", script, file]),
    );

    if (exitCode !== 0)
      return yield* new ClipboardError({ message: `osascript exited with ${exitCode}` });
  },
  Effect.scoped,
  Effect.mapError((error) =>
    Schema.is(ClipboardError)(error) ? error : new ClipboardError({ message: error.message }),
  ),
);
