/** `paper-snapshot`: every behaviour is a flag; defaults suit a one-shot capture into the open Paper file. */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Browser from "./browser.ts";
import * as Capture from "./capture.ts";
import * as Clipboard from "./clipboard.ts";
import * as Extension from "./extension.ts";
import * as Job from "./job.ts";
import * as Paper from "./paper.ts";

const milliseconds = (name: string, fallback: number, description: string) =>
  Flag.integer(name).pipe(Flag.withDescription(`${description} (ms)`), Flag.withDefault(fallback));

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const optionalInteger = (name: string, description: string) =>
  Flag.integer(name).pipe(Flag.withDescription(description), Flag.optional);

const repeatable = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(`${description} (repeatable)`), Flag.atLeast(0));

const toggle = (name: string, fallback: boolean, description: string) =>
  Flag.boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(fallback));

const flags = {
  urls: Argument.string("url").pipe(
    Argument.withDescription(
      "Pages to capture, one artboard each. Paths like /pricing resolve against the first URL or --base-url. Omit to capture the attached browser's current tab",
    ),
    Argument.variadic(),
  ),
  manifest: optionalString(
    "manifest",
    "JSON file of captures: [url | {url, name, selector, width, height, colorScheme, localStorage, cookies, clicks, eval, fileId, pageId, x, y, below, rightOf, replace, …}] or {defaults, items}. Flags are the defaults",
  ),
  baseUrl: optionalString("base-url", "Origin that relative URLs resolve against"),

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
      "Where pages live. launch: a headless installed Chrome. chrome: your everyday Chrome (enable chrome://inspect/#remote-debugging). agent-browser / playwriter / cdp: attach to that browser. auto: launch when a URL is given, otherwise agent-browser, then chrome",
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
    Flag.withFallbackConfig(Config.string("PAPER_SNAPSHOT_BROWSER")),
    Flag.optional,
  ),
  browserArgs: repeatable("browser-arg", "Extra command-line argument for the launched browser"),
  headed: toggle("headed", false, "Show the launched browser"),
  downloadBrowser: toggle(
    "download-browser",
    true,
    "Download headless Chromium when no installed browser is found",
  ),
  connectTimeout: milliseconds("connect-timeout", 30_000, "Browser launch/attach timeout"),

  // Page emulation
  width: optionalInteger(
    "width",
    "Viewport width in px (default 1440; attached tabs keep theirs). The capture is as wide as the selected element",
  ),
  height: optionalInteger(
    "height",
    "Viewport height in px (default 900; attached tabs keep theirs). The capture always covers the selected element's full height; content inside internal scroll containers is unclipped by --full-page",
  ),
  scale: Flag.float("scale").pipe(Flag.withDescription("Device scale factor"), Flag.withDefault(1)),
  colorScheme: Flag.choice("color-scheme", ["light", "dark", "no-preference"]).pipe(
    Flag.withDescription(
      "Emulates the prefers-color-scheme media query only. Apps that keep their theme in storage need --local-storage <key>=dark as well",
    ),
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
    "Playwright storage-state JSON with cookies/localStorage (launched browsers)",
  ),

  // Page state
  localStorage: Flag.keyValuePair("local-storage").pipe(
    Flag.withDescription(
      "localStorage entry set before the page's scripts run, as key=value (repeatable)",
    ),
    Flag.withDefault({}),
  ),
  sessionStorage: Flag.keyValuePair("session-storage").pipe(
    Flag.withDescription(
      "sessionStorage entry set before the page's scripts run, as key=value (repeatable)",
    ),
    Flag.withDefault({}),
  ),
  cookies: repeatable(
    "cookie",
    'Cookie as "name=value", optionally "; domain=…; path=…; secure; httponly" (default: the page\'s URL)',
  ),
  clicks: repeatable("click", "Selector to click after load, in order"),

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
  waitForTimeout: milliseconds(
    "wait-for-timeout",
    30_000,
    "Timeout for --wait-for, --click and --selector",
  ),
  evals: repeatable("eval", "JavaScript to run in the page before capturing"),
  evalFiles: repeatable("eval-file", "File of JavaScript to run in the page before capturing"),
  scroll: toggle("scroll", true, "Scroll through the page first so lazy content loads"),
  scrollStep: optionalInteger("scroll-step", "Scroll step in px (default 80% of the viewport)"),
  scrollDelay: milliseconds("scroll-delay", 120, "Pause between scroll steps"),
  scrollMax: Flag.integer("scroll-max").pipe(
    Flag.withDescription("Stop auto-scrolling after this many px"),
    Flag.withDefault(50_000),
  ),
  settle: milliseconds("settle", 500, "Pause before capturing"),

  // Capture fidelity
  fullPage: toggle(
    "full-page",
    true,
    "Grow the viewport until no internal scroll container (h-screen shells, overflow:auto mains) clips content",
  ),
  fullPageMaxHeight: Flag.integer("full-page-max-height").pipe(
    Flag.withDescription("Cap for the grown viewport in px"),
    Flag.withDefault(30_000),
  ),
  inlineSprites: toggle(
    "inline-sprites",
    true,
    "Inline external SVG sprites (<use href=/sprite.svg#id>) with their computed colors",
  ),
  fixColspans: toggle(
    "fix-colspans",
    true,
    "Freeze table rows with colspan cells into full-width rows Paper can lay out",
  ),
  pinImageHeights: toggle(
    "pin-image-heights",
    true,
    "Freeze rendered image heights so Paper keeps aspect ratios",
  ),
  inlineImages: Flag.choice("inline-images", ["auto", "always", "never"]).pipe(
    Flag.withDescription(
      "Embed images as data URIs. auto: only for localhost/private hosts Paper can't reach",
    ),
    Flag.withDefault("auto"),
  ),
  imageTimeout: milliseconds(
    "image-timeout",
    15_000,
    "Per-asset download timeout for images and sprites",
  ),
  captureTimeout: milliseconds("capture-timeout", 120_000, "Serializer timeout"),
  extension: optionalString(
    "extension",
    "Paper Snapshot extension to use: .crx, .zip, unpacked directory, or .js",
  ),
  extensionId: Flag.string("extension-id").pipe(
    Flag.withDescription("Chrome Web Store id of Paper Snapshot"),
    Flag.withDefault(Extension.paperSnapshotId),
  ),
  refreshExtension: toggle(
    "refresh-extension",
    false,
    "Re-download the extension instead of using the cached copy",
  ),
  cacheDir: optionalString("cache-dir", "Cache directory (default ~/.cache/paper-snapshot)"),

  // Outputs
  push: Flag.boolean("push").pipe(
    Flag.withDescription(
      "Create artboards in Paper (default unless --out or --clipboard is given)",
    ),
    Flag.optional,
  ),
  clipboard: toggle(
    "clipboard",
    false,
    "Copy the snapshot for a manual ⌘V into Paper (macOS, single capture)",
  ),
  out: optionalString(
    "out",
    'Write snapshot HTML to a file ("-" for stdout); with several captures, a directory',
  ).pipe(Flag.withAlias("o")),
  json: toggle(
    "json",
    false,
    'Print one JSON line per capture on stdout; failures print {"index", "url", "error"}',
  ),
  quiet: toggle("quiet", false, "Only log warnings and errors (same as --log-level warn)"),
  failFast: toggle("fail-fast", false, "Stop at the first failed capture"),

  // Paper placement
  fileId: optionalString("file-id", "Paper file id (default: the file open in Paper)"),
  pageId: optionalString("page-id", "Paper page id (default: the active page)"),
  name: optionalString("name", "Artboard name (default: page title · host)"),
  x: optionalInteger("x", "Artboard x position on the canvas"),
  y: optionalInteger("y", "Artboard y position on the canvas"),
  below: optionalString("below", "Place the artboard below this artboard id (same page)"),
  rightOf: optionalString("right-of", "Place the artboard right of this artboard id (same page)"),
  replace: optionalString(
    "replace",
    "Re-snapshot into this existing artboard id, keeping its id, position and name",
  ),
  gap: Flag.integer("gap").pipe(
    Flag.withDescription("Space between artboards for --below, --right-of and --layout (px)"),
    Flag.withDefault(80),
  ),
  layout: Flag.choice("layout", ["row", "column", "grid"]).pipe(
    Flag.withDescription(
      "How several captures are arranged, starting from the first one's position",
    ),
    Flag.withDefault("row"),
  ),
  columns: Flag.integer("columns").pipe(
    Flag.withDescription("Columns for --layout grid"),
    Flag.withDefault(4),
  ),
  paperBin: optionalString(
    "paper-bin",
    "Paper CLI that provides the MCP relay (default ~/.paper/bin/paper)",
  ),
  paperTimeout: milliseconds("paper-timeout", 300_000, "Timeout per Paper tool call"),
  keepOnFailure: toggle("keep-on-failure", false, "Keep the artboard when writing into it fails"),
};

type Input = Command.Command.Config.Infer<typeof flags>;

/** Captures in the run failed; each was already reported, so the run only summarizes. */
class CapturesFailed extends Schema.TaggedError<CapturesFailed>()("Cli.CapturesFailed", {
  message: Schema.String,
}) {}

class UsageError extends Schema.TaggedError<UsageError>()("Cli.UsageError", {
  message: Schema.String,
}) {}

const Warnings = Schema.Struct({
  emptySvgs: Schema.Finite,
  unresolvedSprites: Schema.Finite,
  clippedScrollContainers: Schema.Finite,
  unresolvedImages: Schema.Finite,
  lostColspans: Schema.Finite,
});

const Summary = Schema.Struct({
  index: Schema.Finite,
  url: Schema.String,
  title: Schema.String,
  name: Schema.NullOr(Schema.String),
  width: Schema.Finite,
  height: Schema.Finite,
  bytes: Schema.Finite,
  inlinedImages: Schema.Finite,
  warnings: Warnings,
  extensionVersion: Schema.String,
  browser: Schema.String,
  fileId: Schema.NullOr(Schema.String),
  artboardId: Schema.NullOr(Schema.String),
  x: Schema.NullOr(Schema.Finite),
  y: Schema.NullOr(Schema.Finite),
  replaced: Schema.Boolean,
  out: Schema.NullOr(Schema.String),
  clipboard: Schema.Boolean,
});

const Failure = Schema.Struct({
  index: Schema.NullOr(Schema.Finite),
  url: Schema.NullOr(Schema.String),
  error: Schema.Struct({ tag: Schema.String, message: Schema.String }),
});

const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Summary));

const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(Failure));

const chromeUserDataDir = (home: string, localAppData: string) =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => `${home}/Library/Application Support/Google/Chrome`),
    Match.when("win32", () => `${localAppData}\\Google\\Chrome\\User Data`),
    Match.orElse(() => `${home}/.config/google-chrome`),
  );

/** Sources to try in order; auto without a URL attaches to whatever the user or agent is driving. */
const resolveSources = (input: Input, hasUrl: boolean, home: string, localAppData: string) =>
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
        return yield* new UsageError({ message: "--source cdp needs --cdp <endpoint>" });

      return [Browser.Source.Attach({ endpoint: input.cdp.value })];
    }

    return hasUrl ? [launch] : [agentBrowser, chrome];
  });

/** Connects to the first source that works; the error lists why each one failed. */
const connectFirst = (
  browser: Browser.Interface,
  sources: ReadonlyArray<Browser.Source>,
  timeout: Duration.Duration,
): Effect.Effect<Browser.Handle, Browser.BrowserError, Scope.Scope> => {
  const [first, ...rest] = sources;

  if (first === undefined)
    return Effect.fail(new Browser.BrowserError({ message: "No browser source" }));

  const attempt = browser.connect(first, timeout);

  return rest.length === 0
    ? attempt
    : attempt.pipe(
        Effect.catch((error) =>
          connectFirst(browser, rest, timeout).pipe(
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

/** The default job described by the flags. */
const baseJob = (input: Input, scripts: ReadonlyArray<string>): Job.Job => ({
  index: 0,
  url: Option.none(),
  name: input.name,
  selector: input.selector,
  tab: input.tab,
  width: input.width,
  height: input.height,
  scale: input.scale,
  colorScheme: input.colorScheme,
  userAgent: input.userAgent,
  locale: input.locale,
  timezone: input.timezone,
  headers: input.headers,
  storageState: input.storageState,
  localStorage: input.localStorage,
  sessionStorage: input.sessionStorage,
  cookies: input.cookies,
  clicks: input.clicks,
  scripts,
  waitFor: input.waitFor,
  settle: input.settle,
  fullPage: input.fullPage,
  fileId: input.fileId,
  pageId: input.pageId,
  x: input.x,
  y: input.y,
  below: input.below,
  rightOf: input.rightOf,
  replace: input.replace,
});

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Batch layout: where an unplaced job goes, given the artboards placed so far in this run. */
const nextPosition = (
  input: Input,
  placed: ReadonlyArray<Placed>,
): Option.Option<{ readonly x: number; readonly y: number }> => {
  const previous = placed.at(-1);

  if (previous === undefined) return Option.none();

  if (input.layout === "row")
    return Option.some({ x: previous.x + previous.width + input.gap, y: previous.y });

  if (input.layout === "column")
    return Option.some({ x: previous.x, y: previous.y + previous.height + input.gap });

  const columns = Math.max(1, input.columns);

  if (placed.length % columns !== 0)
    return Option.some({ x: previous.x + previous.width + input.gap, y: previous.y });

  const row = placed.slice(-columns);
  const first = row[0] ?? previous;
  const bottom = Math.max(...row.map((artboard) => artboard.y + artboard.height));

  return Option.some({ x: first.x, y: bottom + input.gap });
};

const target = (
  job: Job.Job,
  input: Input,
  name: string,
  layout: Option.Option<{ readonly x: number; readonly y: number }>,
): Paper.Target => {
  if (Option.isSome(job.replace)) {
    return Paper.Target.Replace({
      fileId: job.fileId,
      artboardId: job.replace.value,
      name: job.name,
    });
  }

  const position = Option.isSome(job.below)
    ? Paper.Position.Below({ artboardId: job.below.value, gap: input.gap })
    : Option.isSome(job.rightOf)
      ? Paper.Position.RightOf({ artboardId: job.rightOf.value, gap: input.gap })
      : Option.isSome(job.x) || Option.isSome(job.y)
        ? Paper.Position.At({ x: job.x, y: job.y })
        : Option.match(layout, {
            onNone: () => Paper.Position.Auto(),
            onSome: ({ x, y }) => Paper.Position.At({ x: Option.some(x), y: Option.some(y) }),
          });

  return Paper.Target.Create({ fileId: job.fileId, pageId: job.pageId, name, position });
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "snapshot";

const handler = Effect.fn("paper-snapshot")(function* (input: Input) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.string("HOME").pipe(Config.withDefault("."));
  const localAppData = yield* Config.string("LOCALAPPDATA").pipe(Config.withDefault(""));
  const xdgCache = yield* Config.option(Config.string("XDG_CACHE_HOME"));

  const scripts = [
    ...input.evals,
    ...(yield* Effect.forEach(input.evalFiles, (file) => fs.readFileString(file))),
  ];

  const manifest = yield* Effect.forEach(Option.toArray(input.manifest), (file) =>
    fs.readFileString(file),
  ).pipe(Effect.map((contents) => Option.fromNullishOr(contents[0])));

  const jobs = yield* Job.expand(baseJob(input, scripts), input.urls, manifest, input.baseUrl);
  const batch = jobs.length > 1;
  const push = Option.getOrElse(input.push, () => Option.isNone(input.out) && !input.clipboard);

  if (batch && input.clipboard)
    return yield* new UsageError({ message: "--clipboard takes a single capture" });

  if (batch && Option.getOrUndefined(input.out) === "-")
    return yield* new UsageError({
      message: "--out - takes a single capture; pass a directory for several",
    });

  const cacheDir = Option.getOrElse(input.cacheDir, () =>
    path.join(
      Option.getOrElse(xdgCache, () => path.join(home, ".cache")),
      "paper-snapshot",
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

  const runScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(runScope, exit));

  const hasUrl = jobs.some((job) => Option.isSome(job.url));
  const sources = yield* resolveSources(input, hasUrl, home, localAppData);
  const browser = yield* Browser.Service;

  const handle = yield* connectFirst(browser, sources, Duration.millis(input.connectTimeout)).pipe(
    Scope.provide(runScope),
  );

  yield* Effect.logInfo(`Browser: ${handle.origin}`);

  // One Paper relay for the whole run, opened on first use.
  const paperService = yield* Paper.Service;

  const paper = yield* Effect.cached(
    paperService
      .connect({
        bin: Option.getOrElse(input.paperBin, () => path.join(home, ".paper", "bin", "paper")),
        timeout: Duration.millis(input.paperTimeout),
      })
      .pipe(Scope.provide(runScope)),
  );

  if (batch && Option.isSome(input.out) && push !== true) {
    yield* fs.makeDirectory(input.out.value, { recursive: true });
  }

  const placed: Array<Placed> = [];
  const failures: Array<string> = [];

  for (const job of jobs) {
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* handle.page(
          {
            viewport:
              Option.isNone(job.width) && Option.isNone(job.height)
                ? Option.none()
                : Option.some({
                    width: Option.getOrElse(job.width, () => 1440),
                    height: Option.getOrElse(job.height, () => 900),
                  }),
            scale: job.scale,
            colorScheme: job.colorScheme,
            userAgent: job.userAgent,
            locale: job.locale,
            timezone: job.timezone,
            headers: job.headers,
            storageState: job.storageState,
          },
          Option.isSome(job.url),
          job.tab,
        );

        return yield* Capture.capture(session, job.url, serializer, {
          selector: job.selector,
          state: {
            localStorage: job.localStorage,
            sessionStorage: job.sessionStorage,
            cookies: job.cookies,
            clicks: job.clicks,
          },
          waitUntil: input.waitUntil,
          navigationTimeout: Duration.millis(input.navigationTimeout),
          networkIdleTimeout: Duration.millis(input.networkIdleTimeout),
          waitFor: job.waitFor,
          waitForTimeout: Duration.millis(input.waitForTimeout),
          scripts: job.scripts,
          scroll: {
            enabled: input.scroll,
            step: input.scrollStep,
            delay: Duration.millis(input.scrollDelay),
            maxDistance: input.scrollMax,
          },
          settle: Duration.millis(job.settle),
          fullPage: {
            enabled: job.fullPage,
            maxHeight: input.fullPageMaxHeight,
            settle: Duration.millis(300),
          },
          inlineSprites: input.inlineSprites,
          fixColspans: input.fixColspans,
          pinImageHeights: input.pinImageHeights,
          inlineImages: input.inlineImages,
          imageTimeout: Duration.millis(input.imageTimeout),
          captureTimeout: Duration.millis(input.captureTimeout),
        });
      }),
    ).pipe(
      Effect.flatMap((snapshot) =>
        Effect.gen(function* () {
          const name = Option.getOrElse(
            job.name,
            () => `${snapshot.title} · ${URL.parse(snapshot.url)?.host ?? snapshot.url}`,
          );

          const warned = Object.entries(snapshot.warnings).filter(([, count]) => count > 0);

          if (warned.length > 0) {
            yield* Effect.logWarning(
              `${name}: ${warned.map(([kind, count]) => `${count} ${kind}`).join(", ")}`,
            );
          }

          const out = Option.map(input.out, (location) =>
            batch ? path.join(location, `${job.index + 1}-${slug(name)}.html`) : location,
          );

          if (Option.isSome(out)) {
            if (out.value === "-") yield* Console.log(snapshot.html);
            else yield* fs.writeFileString(out.value, snapshot.html);
          }

          if (input.clipboard) {
            yield* Clipboard.write(snapshot.html);
            yield* Effect.logInfo("Copied to the clipboard; paste into Paper with ⌘V");
          }

          const artboard = push
            ? Option.some(
                yield* paper.pipe(
                  Effect.flatMap((connection) =>
                    connection.place(
                      target(
                        job,
                        input,
                        name,
                        Job.isPlaced(job) ? Option.none() : nextPosition(input, placed),
                      ),
                      { width: snapshot.width, height: snapshot.height },
                      snapshot.html,
                      input.keepOnFailure,
                    ),
                  ),
                ),
              )
            : Option.none();

          yield* Effect.forEach(Option.toArray(artboard), (done) =>
            Effect.gen(function* () {
              placed.push(done);
              yield* Effect.logInfo(
                `${done.replaced ? "Replaced" : "Created"} artboard ${done.artboardId} in file ${done.fileId}`,
              );
            }),
          );

          if (input.json) {
            yield* Console.log(
              yield* encodeSummary({
                index: job.index,
                url: snapshot.url,
                title: snapshot.title,
                name: Option.getOrNull(Option.map(artboard, (done) => done.name)),
                width: snapshot.width,
                height: snapshot.height,
                bytes: snapshot.html.length,
                inlinedImages: snapshot.inlinedImages,
                warnings: snapshot.warnings,
                extensionVersion: serializer.version,
                browser: handle.origin,
                fileId: Option.getOrNull(Option.map(artboard, (done) => done.fileId)),
                artboardId: Option.getOrNull(Option.map(artboard, (done) => done.artboardId)),
                x: Option.getOrNull(Option.map(artboard, (done) => done.x)),
                y: Option.getOrNull(Option.map(artboard, (done) => done.y)),
                replaced: Option.match(artboard, {
                  onNone: () => false,
                  onSome: (done) => done.replaced,
                }),
                out: Option.getOrNull(out),
                clipboard: input.clipboard,
              }),
            );
          }
        }),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          failures.push(error.message);

          const url = Option.getOrNull(job.url);

          if (batch) yield* Effect.logError(`${url ?? "current tab"}: ${error.message}`);

          if (input.json) {
            yield* Console.log(
              yield* encodeFailure({
                index: job.index,
                url,
                error: { tag: error._tag, message: error.message },
              }),
            );
          }

          return input.failFast;
        }),
      ),
    );

    if (outcome === true) break;
  }

  if (failures.length > 0) {
    return yield* new CapturesFailed({
      message: batch
        ? `${failures.length} of ${jobs.length} captures failed`
        : (failures[0] ?? "Capture failed"),
    });
  }
});

/** Applies --quiet and, under --json, reports run-level failures as a JSON line on stdout. */
const run = (input: Input) => {
  const program = handler(input).pipe(
    Effect.scoped,
    Effect.tapError((error) =>
      input.json && !Schema.is(CapturesFailed)(error)
        ? encodeFailure({
            index: null,
            url: null,
            error: { tag: error._tag, message: error.message },
          }).pipe(Effect.flatMap(Console.log), Effect.ignore)
        : Effect.void,
    ),
  );

  return input.quiet
    ? program.pipe(Effect.provideService(References.MinimumLogLevel, "Warn"))
    : program;
};

export const command = Command.make("paper-snapshot", flags, run).pipe(
  Command.withDescription(
    "Snapshot URLs, local dev servers, or an already-open browser tab into Paper as editable layers, using the Paper Snapshot extension's serializer.",
  ),
  Command.withExamples([
    {
      command: "paper-snapshot https://linear.app",
      description: "Whole page into the open Paper file",
    },
    {
      command: 'paper-snapshot http://localhost:3000 -s "#pricing" --width 390 --height 844',
      description: "One element of a local dev server, mobile viewport",
    },
    {
      command: "paper-snapshot http://localhost:3000/ /pricing /settings --layout row",
      description: "Several screens side by side",
    },
    {
      command: "paper-snapshot --manifest screens.json --json",
      description: "A batch from a manifest; one JSON line per artboard",
    },
    {
      command: "paper-snapshot http://localhost:3000/settings --replace 1A-0",
      description: "Refresh an existing artboard after the app changed",
    },
    {
      command:
        "paper-snapshot http://localhost:3000 --local-storage theme=dark --color-scheme dark",
      description: "Dark mode for an app that stores its theme",
    },
    { command: "paper-snapshot", description: "Capture the tab agent-browser is showing" },
    {
      command: "paper-snapshot --source chrome --tab localhost:3000",
      description: "Capture a tab of your everyday Chrome (remote debugging enabled)",
    },
    {
      command: "paper-snapshot --cdp http://localhost:9222",
      description: "Capture the active tab of any CDP browser",
    },
  ]),
);
