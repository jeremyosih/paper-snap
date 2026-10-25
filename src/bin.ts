#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Runtime from "effect/Runtime";
import { CliError, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Browser from "./browser.ts";
import * as Cli from "./cli.ts";
import * as Extension from "./extension.ts";
import * as Paper from "./paper.ts";

// Logs go to stderr so `--out -` and `--json` keep stdout machine-readable.
const LoggerLive = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  Layer.succeed(Logger.LogToStderr, true),
);

const MainLive = Layer.mergeAll(
  Browser.layer,
  Extension.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  Paper.layer,
).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(LoggerLive));

// One readable line per failure; parse errors and help are rendered by the CLI itself.
Command.run(Cli.command, { version: "0.1.2" }).pipe(
  Effect.tapError((error) =>
    CliError.isCliError(error) ? Effect.void : Console.error(`paper-snapshot: ${error.message}`),
  ),
  // Bugs surface as defects; report them instead of exiting silently.
  Effect.tapDefect((defect) =>
    Console.error(
      `paper-snapshot: unexpected error: ${defect instanceof Error ? (defect.stack ?? defect.message) : String(defect)}`,
    ),
  ),
  Effect.provide(MainLive),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    // Exit on success too: an attached browser's CDP socket would otherwise keep Node alive.
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) => {
        onExit(code);
        process.exit(code);
      }),
  }),
);
