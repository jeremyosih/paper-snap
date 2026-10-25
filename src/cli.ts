/** `paper-snap`: every behaviour is a flag; defaults suit a one-shot capture into the open Paper file. */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Browser from "./browser.ts";
import * as Capture from "./capture.ts";
import * as Clipboard from "./clipboard.ts";
import * as Extension from "./extension.ts";
import * as Paper from "./paper.ts";

const milliseconds = (name: string, fallback: number, description: string) =>
  Flag.integer(name).pipe(Flag.withDescription(`${description} (ms)`), Flag.withDefault(fallback));

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const optionalInteger = (name: string, description: string) =>
  Flag.integer(name).pipe(Flag.withDescription(description), Flag.optional);

const repeatable = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(`${description} (repeatable)`), Flag.atLeast(0));

const flags = {
  url: Argument.string("url").pipe(
    Argument.withDescription("Page to load. Omit it to capture the attached browser's current tab"),
    Argument.optional,
  ),

  // Source browser
  source: Flag.choice("source", [
    "auto",
    "launch",
    "chrome",
    "agent-browser",
    "playwriter",
    "cdp",
  ]).pipe(
    Flag.withDescription(
      "Where the page lives. launch: a headless installed Chrome. chrome: your everyday Chrome (enable chrome://inspect/#remote-debugging). agent-browser / playwriter / cdp: attach to that browser. auto: launch when <url> is given, otherwise agent-browser, then chrome",
    ),
    Flag.withDefault("auto"),
  ),
  cdp: optionalString(
    "cdp",
    "CDP endpoint to attach to (http://host:port or ws://…); implies --source cdp",
  ),
  chromeUserDataDir: optionalString(
    "chrome-user-data-dir",
    "Chrome user data directory for --source chrome (default: the platform's Google Chrome profile root)",
  ),
  playwriterEndpoint: Flag.string("playwriter-endpoint").pipe(
    Flag.withDescription("Playwriter relay CDP endpoint"),
    Flag.withDefault("http://127.0.0.1:19988"),
  ),
  tab: optionalString(
    "tab",
    "Attached browsers: capture the tab whose URL or title contains this text (default: the visible tab)",
  ),
  agentBrowserBin: Flag.string("agent-browser-bin").pipe(
    Flag.withDescription("agent-browser executable"),
    Flag.withDefault("agent-browser"),
  ),
  agentBrowserSession: optionalString("agent-browser-session", "agent-browser session name"),
  browser: Flag.string("browser").pipe(
    Flag.withDescription(
      "Chromium-based executable to launch (default: installed Chrome/Edge/Brave/Chromium)",
    ),
    Flag.withFallbackConfig(Config.string("PAPER_SNAP_BROWSER")),
    Flag.optional,
  ),
  browserArgs: repeatable("browser-arg", "Extra command-line argument for the launched browser"),
  headed: Flag.boolean("headed").pipe(
    Flag.withDescription("Show the launched browser"),
    Flag.withDefault(false),
  ),
  downloadBrowser: Flag.boolean("download-browser").pipe(
    Flag.withDescription("Download headless Chromium when no installed browser is found"),
    Flag.withDefault(true),
  ),
  connectTimeout: milliseconds("connect-timeout", 30_000, "Browser launch/attach timeout"),

  // Page emulation
  width: optionalInteger("width", "Viewport width in px (default 1440; attached tabs keep theirs)"),
  height: optionalInteger(
    "height",
    "Viewport height in px (default 900; attached tabs keep theirs)",
  ),
  scale: Flag.float("scale").pipe(Flag.withDescription("Device scale factor"), Flag.withDefault(1)),
  colorScheme: Flag.choice("color-scheme", ["light", "dark", "no-preference"]).pipe(
    Flag.withDescription("Emulated prefers-color-scheme"),
    Flag.optional,
  ),
  userAgent: optionalString("user-agent", "User agent override"),
  locale: optionalString("locale", "Locale, e.g. fr-FR"),
  timezone: optionalString("timezone", "Time zone, e.g. Africa/Douala"),
  headers: Flag.keyValuePair("header").pipe(
    Flag.withDescription("Extra request header as name=value (repeatable)"),
    Flag.withDefault({}),
  ),
  storageState: optionalString(
    "storage-state",
    "Playwright storage-state JSON with cookies/localStorage",
  ),

  // Page preparation
  selector: Flag.string("selector").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("CSS selector of the element to capture"),
    Flag.withDefault("body"),
  ),
  waitUntil: Flag.choice("wait-until", ["load", "domcontentloaded", "networkidle", "commit"]).pipe(
    Flag.withDescription("Navigation milestone to wait for"),
    Flag.withDefault("load"),
  ),
  navigationTimeout: milliseconds("navigation-timeout", 60_000, "Navigation timeout"),
  networkIdleTimeout: milliseconds(
    "network-idle-timeout",
    15_000,
    "Max wait for network idle; 0 skips it",
  ),
  waitFor: optionalString("wait-for", "Selector that must appear before capturing"),
  waitForTimeout: milliseconds("wait-for-timeout", 30_000, "Timeout for --wait-for and --selector"),
  evals: repeatable("eval", "JavaScript to run in the page before capturing"),
  evalFiles: repeatable("eval-file", "File of JavaScript to run in the page before capturing"),
  scroll: Flag.boolean("scroll").pipe(
    Flag.withDescription("Scroll through the page first so lazy content loads"),
    Flag.withDefault(true),
  ),
  scrollStep: optionalInteger("scroll-step", "Scroll step in px (default 80% of the viewport)"),
  scrollDelay: milliseconds("scroll-delay", 120, "Pause between scroll steps"),
  scrollMax: Flag.integer("scroll-max").pipe(
    Flag.withDescription("Stop auto-scrolling after this many px"),
    Flag.withDefault(50_000),
  ),
  settle: milliseconds("settle", 500, "Pause before capturing"),

  // Capture
  pinImageHeights: Flag.boolean("pin-image-heights").pipe(
    Flag.withDescription("Freeze rendered image heights so Paper keeps aspect ratios"),
    Flag.withDefault(true),
  ),
  inlineImages: Flag.choice("inline-images", ["auto", "always", "never"]).pipe(
    Flag.withDescription(
      "Embed images as data URIs. auto: only for localhost/private hosts Paper can't reach",
    ),
    Flag.withDefault("auto"),
  ),
  imageTimeout: milliseconds("image-timeout", 15_000, "Per-image download timeout when inlining"),
  captureTimeout: milliseconds("capture-timeout", 120_000, "Serializer timeout"),
  extension: optionalString(
    "extension",
    "Paper Snapshot extension to use: .crx, .zip, unpacked directory, or .js",
  ),
  extensionId: Flag.string("extension-id").pipe(
    Flag.withDescription("Chrome Web Store id of Paper Snapshot"),
    Flag.withDefault(Extension.paperSnapshotId),
  ),
  refreshExtension: Flag.boolean("refresh-extension").pipe(
    Flag.withDescription("Re-download the extension instead of using the cached copy"),
    Flag.withDefault(false),
  ),
  cacheDir: optionalString("cache-dir", "Cache directory (default ~/.cache/paper-snap)"),

  // Outputs
  push: Flag.boolean("push").pipe(
    Flag.withDescription(
      "Create an artboard in Paper (default unless --out or --clipboard is given)",
    ),
    Flag.optional,
  ),
  clipboard: Flag.boolean("clipboard").pipe(
    Flag.withDescription("Copy the snapshot for a manual ⌘V into Paper (macOS)"),
    Flag.withDefault(false),
  ),
  out: optionalString("out", 'Write the snapshot HTML to a file, or "-" for stdout').pipe(
    Flag.withAlias("o"),
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print a JSON result summary on stdout"),
    Flag.withDefault(false),
  ),

  // Paper
  fileId: optionalString("file-id", "Paper file id (default: the file open in Paper)"),
  pageId: optionalString("page-id", "Paper page id (default: the active page)"),
  name: optionalString("name", "Artboard name (default: page title · host)"),
  x: optionalInteger("x", "Artboard x position on the canvas"),
  y: optionalInteger("y", "Artboard y position on the canvas"),
  paperBin: optionalString(
    "paper-bin",
    "Paper CLI that provides the MCP relay (default ~/.paper/bin/paper)",
  ),
  paperTimeout: milliseconds("paper-timeout", 300_000, "Timeout per Paper tool call"),
  keepOnFailure: Flag.boolean("keep-on-failure").pipe(
    Flag.withDescription("Keep the artboard when writing into it fails"),
    Flag.withDefault(false),
  ),
};

type Input = Command.Command.Config.Infer<typeof flags>;

const Summary = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  width: Schema.Finite,
  height: Schema.Finite,
  bytes: Schema.Finite,
  inlinedImages: Schema.Finite,
  extensionVersion: Schema.String,
  browser: Schema.String,
  fileId: Schema.NullOr(Schema.String),
  artboardId: Schema.NullOr(Schema.String),
  out: Schema.NullOr(Schema.String),
  clipboard: Schema.Boolean,
});

const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Summary));

const chromeUserDataDir = (home: string, localAppData: string) =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => `${home}/Library/Application Support/Google/Chrome`),
    Match.when("win32", () => `${localAppData}\\Google\\Chrome\\User Data`),
    Match.orElse(() => `${home}/.config/google-chrome`),
  );

/** Sources to try in order; auto without a URL attaches to whatever the user or agent is driving. */
const resolveSources = (input: Input, home: string, localAppData: string) =>
  Effect.gen(function* () {
    const source = Option.isSome(input.cdp) && input.source === "auto" ? "cdp" : input.source;

    const launch = Browser.Source.Launch({
      executablePath: input.browser,
      headed: input.headed,
      args: input.browserArgs,
      download: input.downloadBrowser,
    });

    const agentBrowser = Browser.Source.AgentBrowser({
      bin: input.agentBrowserBin,
      session: input.agentBrowserSession,
    });

    const chrome = Browser.Source.Chrome({
      userDataDir: Option.getOrElse(input.chromeUserDataDir, () =>
        chromeUserDataDir(home, localAppData),
      ),
    });

    if (source === "launch") return [launch];

    if (source === "chrome") return [chrome];

    if (source === "agent-browser") return [agentBrowser];

    if (source === "playwriter")
      return [Browser.Source.Playwriter({ endpoint: input.playwriterEndpoint })];

    if (source === "cdp") {
      if (Option.isNone(input.cdp))
        return yield* new Browser.BrowserError({ message: "--source cdp needs --cdp <endpoint>" });

      return [Browser.Source.Attach({ endpoint: input.cdp.value })];
    }

    return Option.isSome(input.url) ? [launch] : [agentBrowser, chrome];
  });

/** Opens the first source that works; the error lists why each one failed. */
const openFirst = (
  browser: Browser.Interface,
  sources: ReadonlyArray<Browser.Source>,
  settings: Browser.PageSettings,
  freshTab: boolean,
): Effect.Effect<Browser.Session, Browser.BrowserError, Scope.Scope> => {
  const [first, ...rest] = sources;

  if (first === undefined)
    return Effect.fail(new Browser.BrowserError({ message: "No browser source" }));

  const attempt = browser.open(first, settings, freshTab);

  return rest.length === 0
    ? attempt
    : attempt.pipe(
        Effect.catch((error) =>
          openFirst(browser, rest, settings, freshTab).pipe(
            Effect.mapError(
              (next) =>
                new Browser.BrowserError({
                  message: `${first._tag}: ${error.message}; ${next.message}`,
                }),
            ),
          ),
        ),
      );
};

const handler = Effect.fn("paper-snap")(function* (input: Input) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.string("HOME").pipe(Config.withDefault("."));
  const xdgCache = yield* Config.option(Config.string("XDG_CACHE_HOME"));

  const push = Option.getOrElse(input.push, () => Option.isNone(input.out) && !input.clipboard);

  const scripts = [
    ...input.evals,
    ...(yield* Effect.forEach(input.evalFiles, (file) => fs.readFileString(file))),
  ];

  const cacheDir = Option.getOrElse(input.cacheDir, () =>
    path.join(
      Option.getOrElse(xdgCache, () => path.join(home, ".cache")),
      "paper-snap",
    ),
  );

  const extension = yield* Extension.Service;

  const serializer = yield* extension.serializer({
    extensionId: input.extensionId,
    localPath: input.extension,
    cacheDir,
    refresh: input.refreshExtension,
  });

  yield* Effect.logDebug(`Paper Snapshot ${serializer.version} from ${serializer.origin}`);

  const localAppData = yield* Config.string("LOCALAPPDATA").pipe(Config.withDefault(""));
  const sources = yield* resolveSources(input, home, localAppData);
  const browser = yield* Browser.Service;

  const viewport =
    Option.isNone(input.width) && Option.isNone(input.height)
      ? Option.none()
      : Option.some({
          width: Option.getOrElse(input.width, () => 1440),
          height: Option.getOrElse(input.height, () => 900),
        });

  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* openFirst(
        browser,
        sources,
        {
          viewport,
          scale: input.scale,
          colorScheme: input.colorScheme,
          userAgent: input.userAgent,
          locale: input.locale,
          timezone: input.timezone,
          headers: input.headers,
          storageState: input.storageState,
          connectTimeout: Duration.millis(input.connectTimeout),
          tab: input.tab,
        },
        Option.isSome(input.url),
      );

      yield* Effect.logInfo(`Browser: ${session.origin}`);

      const captured = yield* Capture.capture(session, input.url, serializer, {
        selector: input.selector,
        waitUntil: input.waitUntil,
        navigationTimeout: Duration.millis(input.navigationTimeout),
        networkIdleTimeout: Duration.millis(input.networkIdleTimeout),
        waitFor: input.waitFor,
        waitForTimeout: Duration.millis(input.waitForTimeout),
        scripts,
        scroll: {
          enabled: input.scroll,
          step: input.scrollStep,
          delay: Duration.millis(input.scrollDelay),
          maxDistance: input.scrollMax,
        },
        settle: Duration.millis(input.settle),
        pinImageHeights: input.pinImageHeights,
        inlineImages: input.inlineImages,
        imageTimeout: Duration.millis(input.imageTimeout),
        captureTimeout: Duration.millis(input.captureTimeout),
      });

      return { ...captured, browser: session.origin };
    }),
  );

  yield* Effect.logInfo(`Captured ${Math.round(snapshot.html.length / 1024)} KB of HTML`);

  if (Option.isSome(input.out)) {
    if (input.out.value === "-") yield* Console.log(snapshot.html);
    else yield* fs.writeFileString(input.out.value, snapshot.html);
  }

  if (input.clipboard) {
    yield* Clipboard.write(snapshot.html);
    yield* Effect.logInfo("Copied to the clipboard; paste into Paper with ⌘V");
  }

  const artboard = push
    ? Option.some(
        yield* Effect.scoped(
          Effect.gen(function* () {
            const paper = yield* Paper.Service;

            const connection = yield* paper.connect({
              bin: Option.getOrElse(input.paperBin, () =>
                path.join(home, ".paper", "bin", "paper"),
              ),
              timeout: Duration.millis(input.paperTimeout),
            });

            return yield* connection.place(
              {
                fileId: input.fileId,
                pageId: input.pageId,
                name: Option.getOrElse(
                  input.name,
                  () => `${snapshot.title} · ${URL.parse(snapshot.url)?.host ?? snapshot.url}`,
                ),
                width: snapshot.width,
                height: snapshot.height,
                x: input.x,
                y: input.y,
              },
              snapshot.html,
              input.keepOnFailure,
            );
          }),
        ),
      )
    : Option.none();

  yield* Effect.forEach(Option.toArray(artboard), (placed) =>
    Effect.logInfo(`Created artboard ${placed.artboardId} in file ${placed.fileId}`),
  );

  if (input.json) {
    const summary = yield* encodeSummary({
      url: snapshot.url,
      title: snapshot.title,
      width: snapshot.width,
      height: snapshot.height,
      bytes: snapshot.html.length,
      inlinedImages: snapshot.inlinedImages,
      extensionVersion: serializer.version,
      browser: snapshot.browser,
      fileId: Option.getOrNull(Option.map(artboard, (placed) => placed.fileId)),
      artboardId: Option.getOrNull(Option.map(artboard, (placed) => placed.artboardId)),
      out: Option.getOrNull(input.out),
      clipboard: input.clipboard,
    });

    yield* Console.log(summary);
  }
});

export const command = Command.make("paper-snap", flags, handler).pipe(
  Command.withDescription(
    "Snapshot a URL, local dev server, or an already-open browser tab into Paper as editable layers, using the Paper Snapshot extension's serializer.",
  ),
  Command.withExamples([
    {
      command: "paper-snap https://linear.app",
      description: "Whole page into the open Paper file",
    },
    {
      command: 'paper-snap http://localhost:3000 -s "#pricing" --width 390 --height 844',
      description: "One element of a local dev server, mobile viewport",
    },
    { command: "paper-snap", description: "Capture the tab agent-browser is showing" },
    {
      command: "paper-snap --source chrome --tab localhost:3000",
      description: "Capture a tab of your everyday Chrome (remote debugging enabled)",
    },
    {
      command: "paper-snap --source playwriter --tab localhost:3000",
      description: "Capture a tab of your own Chrome through the Playwriter extension",
    },
    {
      command: "paper-snap --cdp http://localhost:9222",
      description: "Capture the active tab of any CDP browser",
    },
    {
      command: "paper-snap https://example.com --out snap.html --json",
      description: "HTML only, JSON summary",
    },
  ]),
);
