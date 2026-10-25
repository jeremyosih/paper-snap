/** Human-readable log lines on stderr: `› step`, `✓ result`, `! warning`, `✗ error`. */
import * as Logger from "effect/Logger";
import * as Match from "effect/Match";

const colored = process.stderr.isTTY === true;

const paint = (code: number, text: string) => (colored ? `\u001B[${code}m${text}\u001B[0m` : text);

/** Lines that report something the user asked for, rather than a step on the way. */
const outcome = /^(?:Created|Replaced) artboard|^Copied to the clipboard/;

export const human = Logger.make((options) => {
  const message = options.message;
  const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);

  const mark = Match.value(options.logLevel).pipe(
    Match.when("Warn", () => paint(33, "!")),
    Match.when("Error", () => paint(31, "✗")),
    Match.when("Fatal", () => paint(31, "✗")),
    Match.when("Info", () => (outcome.test(text) ? paint(32, "✓") : paint(2, "›"))),
    Match.orElse(() => paint(2, "·")),
  );

  process.stderr.write(`${mark} ${text}\n`);
});
