/** Chromium pages from a launched local browser or an attached one (Chrome, agent-browser, Playwriter, CDP). */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

export type Source = Data.TaggedEnum<{
  Launch: {
    readonly executablePath: Option.Option<string>;
    readonly headed: boolean;
    readonly args: ReadonlyArray<string>;
    readonly download: boolean;
  };
  Attach: { readonly endpoint: string };
  /** Playwriter's relay, which drives the user's own Chrome through its extension. */
  Playwriter: { readonly endpoint: string };
  AgentBrowser: { readonly bin: string; readonly session: Option.Option<string> };
  /**
   * The user's everyday Chrome, after "Remote debugging" is enabled at
   * chrome://inspect/#remote-debugging (Chrome 144+). Chrome asks the user to allow each connection.
   */
  Chrome: {
    readonly userDataDir: string;
    /** Used when DevToolsActivePort can't be read (sandboxed or remote callers). */
    readonly port: number;
    /** How long to wait for the user to click Allow. */
    readonly approvalTimeout: Duration.Duration;
  };
}>;

export const Source = Data.taggedEnum<Source>();

type ColorScheme = "light" | "dark" | "no-preference";

interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Per-capture page emulation. */
export interface PageSettings {
  /** None keeps an attached tab's current viewport; launched browsers fall back to 1440×900. */
  readonly viewport: Option.Option<Viewport>;
  readonly scale: number;
  readonly colorScheme: Option.Option<ColorScheme>;
  readonly userAgent: Option.Option<string>;
  readonly locale: Option.Option<string>;
  readonly timezone: Option.Option<string>;
  readonly headers: Readonly<Record<string, string>>;
  readonly storageState: Option.Option<string>;
}

export interface Session {
  readonly page: Page;
  readonly context: BrowserContext;
  /** Whether the page is a tab the user or an agent already had open. */
  readonly existingTab: boolean;
}

/** A connected or launched browser, shared by every capture in a run. */
export interface Handle {
  /** Human-readable description of where pages come from. */
  readonly origin: string;
  /**
   * A page for one capture, released with the scope. Launched browsers always get a fresh
   * context. Attached browsers get a new tab with `freshTab`, otherwise the tab matching `tab`
   * (URL or title text), else the visible tab.
   */
  readonly page: (
    settings: PageSettings,
    freshTab: boolean,
    tab: Option.Option<string>,
  ) => Effect.Effect<Session, BrowserError, Scope.Scope>;
}

export class BrowserError extends Schema.TaggedError<
  BrowserError,
  { readonly brand: unique symbol }
>()("Browser.BrowserError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly connect: (
    source: Source,
    connectTimeout: Duration.Duration,
  ) => Effect.Effect<Handle, BrowserError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "paper-snapshot-cli/browser/Service",
) {}

const defaultViewport: Viewport = { width: 1440, height: 900 };

const installedBrowsersByPlatform = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
} as const;

const installedBrowsers = (platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === "darwin" || platform === "linux" || platform === "win32"
    ? installedBrowsersByPlatform[platform]
    : [];

const firstLine = (error: Error) => error.message.split("\n")[0] ?? error.message;

const toBrowserError = (action: string) => (error: Error) =>
  new BrowserError({ message: `${action}: ${firstLine(error)}` });

const attempt = <A>(action: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      toBrowserError(action)(error instanceof Error ? error : new Error(String(error))),
  });

const cdpUrlPattern = /(?:wss?|https?):\/\/\S+/;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const run = (command: string, args: ReadonlyArray<string>, timeout: Duration.Duration) =>
      spawner.string(ChildProcess.make(command, args)).pipe(
        Effect.timeout(timeout),
        Effect.mapError(
          (error) =>
            new BrowserError({
              message: `\`${command} ${args.join(" ")}\` failed: ${error.message}`,
            }),
        ),
      );

    const close = (browser: Browser) => Effect.promise(() => browser.close()).pipe(Effect.ignore);

    const downloadChromium = Effect.fn("Browser.downloadChromium")(function* (
      timeout: Duration.Duration,
    ) {
      const cli = yield* path
        .fromFileUrl(new URL(import.meta.resolve("playwright-core/cli.js")))
        .pipe(
          Effect.mapError(
            () => new BrowserError({ message: "Could not locate playwright-core's CLI" }),
          ),
        );

      yield* Effect.logWarning(
        "No installed Chrome found; downloading headless Chromium (one time)",
      );
      yield* run(process.execPath, [cli, "install", "chromium-headless-shell"], timeout);
    });

    const launch = Effect.fn("Browser.launch")(function* (
      source: Extract<Source, { readonly _tag: "Launch" }>,
      timeout: Duration.Duration,
    ) {
      const requested = source.executablePath;
      const known = installedBrowsers(process.platform);

      const candidates = Option.match(requested, {
        onNone: () => known,
        onSome: (explicit) => [explicit],
      });

      const options = {
        headless: !source.headed,
        args: [...source.args],
        timeout: Duration.toMillis(timeout),
      };

      for (const executablePath of candidates) {
        const exists = yield* fs.exists(executablePath).pipe(Effect.orElseSucceed(() => false));

        if (!exists) continue;

        const browser = yield* attempt(`Launching ${executablePath}`, () =>
          chromium.launch({ ...options, executablePath }),
        ).pipe(Effect.option);

        if (Option.isSome(browser))
          return { browser: browser.value, origin: path.basename(executablePath) };
      }

      if (Option.isSome(requested)) {
        return yield* new BrowserError({
          message: `Could not launch the browser at ${requested.value}`,
        });
      }

      const bundled = yield* attempt("Launching Playwright's Chromium", () =>
        chromium.launch(options),
      ).pipe(Effect.option);

      if (Option.isSome(bundled)) return { browser: bundled.value, origin: "playwright chromium" };

      if (!source.download) {
        return yield* new BrowserError({
          message:
            "No Chromium-based browser found. Install Chrome, pass --browser <path>, or allow --download-browser",
        });
      }

      yield* downloadChromium(Duration.minutes(10));

      const downloaded = yield* attempt("Launching downloaded Chromium", () =>
        chromium.launch(options),
      );

      return { browser: downloaded, origin: "playwright chromium" };
    });

    const agentBrowserEndpoint = Effect.fn("Browser.agentBrowserEndpoint")(function* (
      source: Extract<Source, { readonly _tag: "AgentBrowser" }>,
      timeout: Duration.Duration,
    ) {
      const sessionArgs = Option.match(source.session, {
        onNone: () => [],
        onSome: (name) => ["--session", name],
      });

      const output = yield* run(source.bin, [...sessionArgs, "get", "cdp-url"], timeout);
      const endpoint = cdpUrlPattern.exec(output)?.[0];

      if (endpoint === undefined) {
        return yield* new BrowserError({
          message: `agent-browser returned no CDP URL (is a session open?): ${output.trim() || "<empty>"}`,
        });
      }

      return endpoint;
    });

    const agentBrowserUrl = Effect.fn("Browser.agentBrowserUrl")(function* (
      source: Extract<Source, { readonly _tag: "AgentBrowser" }>,
      timeout: Duration.Duration,
    ) {
      const sessionArgs = Option.match(source.session, {
        onNone: () => [],
        onSome: (name) => ["--session", name],
      });

      const output = yield* run(source.bin, [...sessionArgs, "get", "url"], timeout);
      const url = /(?:https?|file):\/\/\S+/.exec(output)?.[0];

      if (url === undefined)
        return yield* new BrowserError({ message: "agent-browser has no active URL" });

      return url;
    });

    const contextOptions = (settings: PageSettings) => ({
      viewport: Option.getOrElse(settings.viewport, () => defaultViewport),
      deviceScaleFactor: settings.scale,
      extraHTTPHeaders: settings.headers,
      ...Option.match(settings.colorScheme, {
        onNone: () => ({}),
        onSome: (colorScheme) => ({ colorScheme }),
      }),
      ...Option.match(settings.userAgent, {
        onNone: () => ({}),
        onSome: (userAgent) => ({ userAgent }),
      }),
      ...Option.match(settings.locale, { onNone: () => ({}), onSome: (locale) => ({ locale }) }),
      ...Option.match(settings.timezone, {
        onNone: () => ({}),
        onSome: (timezoneId) => ({ timezoneId }),
      }),
      ...Option.match(settings.storageState, {
        onNone: () => ({}),
        onSome: (storageState) => ({ storageState }),
      }),
    });

    const launchedHandle = Effect.fn("Browser.launchedHandle")(function* (
      source: Extract<Source, { readonly _tag: "Launch" }>,
      connectTimeout: Duration.Duration,
    ) {
      const { browser, origin } = yield* Effect.acquireRelease(
        launch(source, connectTimeout),
        ({ browser }) => close(browser),
      );

      const page = Effect.fn("Browser.launchedPage")(function* (settings: PageSettings) {
        const context = yield* Effect.acquireRelease(
          attempt("Creating browser context", () => browser.newContext(contextOptions(settings))),
          (context) => Effect.promise(() => context.close()).pipe(Effect.ignore),
        );

        const tab = yield* attempt("Opening tab", () => context.newPage());

        return { page: tab, context, existingTab: false };
      });

      return { origin, page } satisfies Handle;
    });

    /** The tab the user or agent is looking at: a URL/title match, else the visible tab, else the last. */
    const pickTab = Effect.fn("Browser.pickTab")(function* (
      pages: ReadonlyArray<Page>,
      match: Option.Option<string>,
    ) {
      if (Option.isSome(match)) {
        const needle = match.value;

        for (const page of pages) {
          const title = yield* attempt("Reading tab title", () => page.title()).pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => ""),
          );

          if (page.url().includes(needle) || title.includes(needle)) return page;
        }

        return yield* new BrowserError({ message: `No open tab matches --tab ${needle}` });
      }

      // Browser-internal pages (new tab, devtools) are never what anyone means to capture.
      const content = pages.filter((page) => /^(?:https?|file):/.test(page.url()));

      // Background tabs can be frozen, so every probe is bounded.
      for (const page of content) {
        const visible = yield* attempt("Probing tab", () =>
          page.evaluate(() => document.visibilityState === "visible"),
        ).pipe(
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => false),
        );

        if (visible) return page;
      }

      return content.at(-1) ?? pages.at(-1);
    });

    /** Applies emulation to an attached tab; an existing tab gets it removed again on release. */
    const emulate = Effect.fn("Browser.emulate")(function* (
      page: Page,
      settings: PageSettings,
      existingTab: boolean,
    ) {
      yield* Effect.forEach(Option.toArray(settings.viewport), (viewport) =>
        attempt("Resizing viewport", () => page.setViewportSize(viewport)),
      );
      yield* Effect.forEach(Option.toArray(settings.colorScheme), (colorScheme) =>
        attempt("Emulating color scheme", () => page.emulateMedia({ colorScheme })),
      );

      if (Object.keys(settings.headers).length > 0) {
        yield* attempt("Setting headers", () => page.setExtraHTTPHeaders(settings.headers));
      }

      if (Option.isSome(settings.storageState)) {
        yield* Effect.logWarning(
          "--storage-state applies to launched browsers; attached browsers keep their own session",
        );
      }

      if (
        existingTab &&
        (Option.isSome(settings.viewport) || Option.isSome(settings.colorScheme))
      ) {
        yield* Effect.addFinalizer(() =>
          attempt("Restoring tab", async () => {
            await page.emulateMedia({ colorScheme: null });
            const session = await page.context().newCDPSession(page);
            await session.send("Emulation.clearDeviceMetricsOverride");
            await session.detach();
          }).pipe(Effect.ignore),
        );
      }
    });

    const attachedHandle = Effect.fn("Browser.attachedHandle")(function* (
      endpoint: string,
      origin: string,
      connectTimeout: Duration.Duration,
      defaultTab: Option.Option<string>,
    ) {
      // Never `browser.close()` an attached browser: over CDP that closes the user's Chrome.
      // The connection ends with the process.
      const browser = yield* attempt(`Connecting to ${endpoint}`, () =>
        chromium.connectOverCDP(endpoint, { timeout: Duration.toMillis(connectTimeout) }),
      );

      const context = browser.contexts()[0];

      if (context === undefined)
        return yield* new BrowserError({ message: `${endpoint} has no browser context` });

      const page = Effect.fn("Browser.attachedPage")(function* (
        settings: PageSettings,
        freshTab: boolean,
        tab: Option.Option<string>,
      ) {
        const target = freshTab
          ? yield* Effect.acquireRelease(
              attempt("Opening tab", () => context.newPage()),
              (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore),
            )
          : yield* pickTab(
              context.pages(),
              Option.orElse(tab, () => defaultTab),
            );

        if (target === undefined)
          return yield* new BrowserError({ message: `${endpoint} has no open tab` });

        yield* emulate(target, settings, !freshTab);

        return { page: target, context, existingTab: !freshTab };
      });

      return { origin, page } satisfies Handle;
    });

    /** Chrome publishes its debugging port and browser path in `<user data dir>/DevToolsActivePort`. */
    const chromeEndpoint = Effect.fn("Browser.chromeEndpoint")(function* (
      userDataDir: string,
      fallbackPort: number,
    ) {
      const file = path.join(userDataDir, "DevToolsActivePort");
      const contents = yield* fs.readFileString(file).pipe(Effect.option);

      // macOS privacy rules hide Chrome's profile from some apps (and the file is absent when
      // remote debugging is off). Chrome also accepts the browser endpoint without its id.
      if (Option.isNone(contents)) {
        yield* Effect.logDebug(`Can't read ${file}; trying 127.0.0.1:${fallbackPort}`);

        return `ws://127.0.0.1:${fallbackPort}/devtools/browser`;
      }

      const [port, browserPath] = contents.value.split("\n").map((line) => line.trim());

      if (
        port === undefined ||
        browserPath === undefined ||
        !/^\d+$/.test(port) ||
        !browserPath.startsWith("/")
      ) {
        return yield* new BrowserError({ message: `Unrecognised ${file}` });
      }

      return `ws://127.0.0.1:${port}${browserPath}`;
    });

    const connect = Effect.fn("Browser.connect")(function* (
      source: Source,
      connectTimeout: Duration.Duration,
    ) {
      return yield* Source.$match(source, {
        Launch: (launchSource) => launchedHandle(launchSource, connectTimeout),
        Attach: ({ endpoint }) => attachedHandle(endpoint, endpoint, connectTimeout, Option.none()),
        Playwriter: ({ endpoint }) =>
          attachedHandle(endpoint, "playwriter", connectTimeout, Option.none()),
        Chrome: ({ userDataDir, port, approvalTimeout }) =>
          Effect.gen(function* () {
            const endpoint = yield* chromeEndpoint(userDataDir, port);

            // A warning, so it shows under --quiet: nothing proceeds until the user answers.
            yield* Effect.logWarning(
              'Chrome is asking to "Allow remote debugging?" — click Allow in Chrome to continue',
            );

            return yield* attachedHandle(
              endpoint,
              "chrome",
              Duration.max(connectTimeout, approvalTimeout),
              Option.none(),
            ).pipe(
              Effect.mapError(
                (error) =>
                  new BrowserError({
                    message: `Could not attach to Chrome (${error.message}). Turn on chrome://inspect/#remote-debugging, keep Chrome open, and click Allow when it asks; Cancel refuses the connection`,
                  }),
              ),
            );
          }),
        AgentBrowser: (agentSource) =>
          Effect.gen(function* () {
            const endpoint = yield* agentBrowserEndpoint(agentSource, connectTimeout);
            // agent-browser knows which tab it is driving; that is the default tab.
            const current = yield* agentBrowserUrl(agentSource, connectTimeout).pipe(Effect.option);

            return yield* attachedHandle(endpoint, "agent-browser", connectTimeout, current);
          }),
      });
    });

    return Service.of({ connect });
  }),
);
