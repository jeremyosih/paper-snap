/** Acquires a Chromium page: a launched local browser, a CDP endpoint, or agent-browser's session. */
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
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
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
  Chrome: { readonly userDataDir: string };
}>;

export const Source = Data.taggedEnum<Source>();

type ColorScheme = "light" | "dark" | "no-preference";

interface Viewport {
  readonly width: number;
  readonly height: number;
}

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
  readonly connectTimeout: Duration.Duration;
  /** Attached browsers: pick the tab whose URL or title contains this text. */
  readonly tab: Option.Option<string>;
}

export interface Session {
  readonly page: Page;
  readonly context: BrowserContext;
  /** Human-readable description of where the page came from. */
  readonly origin: string;
}

export class BrowserError extends Schema.TaggedError<BrowserError>()("Browser.BrowserError", {
  message: Schema.String,
}) {}

export interface Interface {
  /**
   * Opens a page. With `freshTab` an attached browser gets a new tab that is closed with the
   * scope; without it the attached browser's active tab is used as-is.
   */
  readonly open: (
    source: Source,
    settings: PageSettings,
    freshTab: boolean,
  ) => Effect.Effect<Session, BrowserError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("paper-snap/browser/Service") {}

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

    const openLaunched = Effect.fn("Browser.openLaunched")(function* (
      source: Extract<Source, { readonly _tag: "Launch" }>,
      settings: PageSettings,
    ) {
      const { browser, origin } = yield* Effect.acquireRelease(
        launch(source, settings.connectTimeout),
        ({ browser }) => close(browser),
      );

      const context = yield* attempt("Creating browser context", () =>
        browser.newContext(contextOptions(settings)),
      );

      const page = yield* attempt("Opening tab", () => context.newPage());

      return { page, context, origin };
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

    const openAttached = Effect.fn("Browser.openAttached")(function* (
      endpoint: string,
      origin: string,
      settings: PageSettings,
      freshTab: boolean,
    ) {
      // Never `browser.close()` an attached browser: over CDP that closes the user's Chrome.
      // The connection ends with the process.
      const browser = yield* attempt(`Connecting to ${endpoint}`, () =>
        chromium.connectOverCDP(endpoint, { timeout: Duration.toMillis(settings.connectTimeout) }),
      );

      const context = browser.contexts()[0];

      if (context === undefined)
        return yield* new BrowserError({ message: `${endpoint} has no browser context` });

      const page = freshTab
        ? yield* Effect.acquireRelease(
            attempt("Opening tab", () => context.newPage()),
            (tab) => Effect.promise(() => tab.close()).pipe(Effect.ignore),
          )
        : yield* pickTab(context.pages(), settings.tab);

      if (page === undefined)
        return yield* new BrowserError({ message: `${endpoint} has no open tab` });
      yield* Effect.forEach(Option.toArray(settings.viewport), (viewport) =>
        attempt("Resizing viewport", () => page.setViewportSize(viewport)),
      );
      yield* Effect.forEach(Option.toArray(settings.colorScheme), (colorScheme) =>
        attempt("Emulating color scheme", () => page.emulateMedia({ colorScheme })),
      );

      if (Object.keys(settings.headers).length > 0) {
        yield* attempt("Setting headers", () => page.setExtraHTTPHeaders(settings.headers));
      }

      return { page, context, origin };
    });

    /** Chrome publishes its debugging port and browser path in `<user data dir>/DevToolsActivePort`. */
    const chromeEndpoint = Effect.fn("Browser.chromeEndpoint")(function* (userDataDir: string) {
      const file = path.join(userDataDir, "DevToolsActivePort");

      const contents = yield* fs.readFileString(file).pipe(
        Effect.mapError(
          () =>
            new BrowserError({
              message: `Chrome remote debugging is off (no ${file}). Enable it at chrome://inspect/#remote-debugging`,
            }),
        ),
      );

      const [port, browserPath] = contents.split("\n").map((line) => line.trim());

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

    const open = Effect.fn("Browser.open")(function* (
      source: Source,
      settings: PageSettings,
      freshTab: boolean,
    ) {
      return yield* Source.$match(source, {
        Launch: (launchSource) => openLaunched(launchSource, settings),
        Attach: ({ endpoint }) => openAttached(endpoint, endpoint, settings, freshTab),
        Playwriter: ({ endpoint }) => openAttached(endpoint, "playwriter", settings, freshTab),
        Chrome: ({ userDataDir }) =>
          Effect.gen(function* () {
            const endpoint = yield* chromeEndpoint(userDataDir);

            yield* Effect.logInfo("Connecting to Chrome; click Allow if Chrome asks");

            return yield* openAttached(endpoint, "chrome", settings, freshTab);
          }),
        AgentBrowser: (agentSource) =>
          Effect.gen(function* () {
            const endpoint = yield* agentBrowserEndpoint(agentSource, settings.connectTimeout);

            // agent-browser knows which tab it is driving; default --tab to that tab's URL.
            const tab = Option.isSome(settings.tab)
              ? settings.tab
              : yield* agentBrowserUrl(agentSource, settings.connectTimeout).pipe(Effect.option);

            return yield* openAttached(endpoint, "agent-browser", { ...settings, tab }, freshTab);
          }),
      });
    });

    return Service.of({ open });
  }),
);
