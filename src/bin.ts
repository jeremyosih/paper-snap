#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Runtime from "effect/Runtime";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Browser from "./browser.ts";
import * as Cli from "./cli.ts";
import * as Extension from "./extension.ts";
import * as Paper from "./paper.ts";

// Logs go to stderr so `--out -` and `--json` keep stdout machine-readable.
const LoggerLive = Layer.mergeAll(
  Logger.layer([Logger.consolePretty({ stderr: true })]),
  Layer.succeed(Logger.LogToStderr, true),
);

const MainLive = Layer.mergeAll(
  Browser.layer,
  Extension.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  Paper.layer,
).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(LoggerLive));

// One readable line per failure; parse errors and help are rendered by the CLI itself.
Command.run(Cli.command, { version: "0.1.0" }).pipe(
  Effect.tapError((error) => Console.error(`paper-snap: ${error.message}`)),
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
