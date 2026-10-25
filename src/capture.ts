/** Loads and prepares a page, then serializes an element with Paper's snapshot serializer. */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BrowserContext, Page } from "playwright-core";
import type * as Browser from "./browser.ts";
import type * as Extension from "./extension.ts";

type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

type ImageInlining = "auto" | "always" | "never";

export interface Scroll {
  readonly enabled: boolean;
  /** None scrolls by 80% of the viewport height. */
  readonly step: Option.Option<number>;
  readonly delay: Duration.Duration;
  readonly maxDistance: number;
}

export interface Settings {
  readonly selector: string;
  readonly waitUntil: WaitUntil;
  readonly navigationTimeout: Duration.Duration;
  /** Zero skips waiting for the network to go idle. */
  readonly networkIdleTimeout: Duration.Duration;
  readonly waitFor: Option.Option<string>;
  readonly waitForTimeout: Duration.Duration;
  readonly scripts: ReadonlyArray<string>;
  readonly scroll: Scroll;
  readonly settle: Duration.Duration;
  readonly pinImageHeights: boolean;
  readonly inlineImages: ImageInlining;
  readonly imageTimeout: Duration.Duration;
  readonly captureTimeout: Duration.Duration;
}

interface Snapshot {
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly url: string;
  readonly inlinedImages: number;
}

class CaptureError extends Schema.TaggedError<CaptureError>()("Capture.CaptureError", {
  stage: Schema.String,
  message: Schema.String,
}) {}

const CaptureResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), html: Schema.String }),
  Schema.Struct({ status: Schema.Literal("aborted") }),
  Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
]);

const Rect = Schema.Struct({ width: Schema.Finite, height: Schema.Finite });

const step = <A>(stage: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new CaptureError({
        stage,
        message:
          error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error),
      }),
  });

/** Decodes a page result, attributing failures to a pipeline stage. */
const decodeAt =
  <A>(stage: string, schema: Schema.Decoder<A>) =>
  <I>(value: I) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) => new CaptureError({ stage, message: error.message })),
    );

/** Marks the target so the serializer can find it, even inside shadow roots. */
const markAttribute = "data-paper-element-picker";

const privateHost =
  /^(?:localhost|.*\.localhost|.*\.local|.*\.test|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/;

const isPrivateHost = (url: string) => {
  const parsed = URL.parse(url);

  return parsed !== null && privateHost.test(parsed.hostname);
};

const unescapeAttribute = (value: string) =>
  value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const imageReferences = (html: string) => {
  const references = new Set<string>();

  for (const match of html.matchAll(/\bsrc="([^"]+)"/g))
    references.add(unescapeAttribute(match[1] ?? ""));

  for (const match of html.matchAll(/url\(\s*(?:&quot;|["']?)(.*?)(?:&quot;|["']?)\s*\)/g)) {
    references.add(unescapeAttribute(match[1] ?? ""));
  }

  references.delete("");

  return [...references].filter((reference) => !reference.startsWith("data:"));
};

/** Paper cannot reach private hosts, so their assets travel inside the snapshot as data URIs. */
const inlineImages = (
  html: string,
  context: BrowserContext,
  base: string,
  timeout: Duration.Duration,
) =>
  Effect.forEach(
    imageReferences(html),
    (reference) =>
      step("inline-images", async () => {
        const response = await context.request.get(new URL(reference, base).href, {
          timeout: Duration.toMillis(timeout),
        });

        if (!response.ok()) return Option.none<readonly [string, string]>();

        const type =
          response.headers()["content-type"]?.split(";")[0] ?? "application/octet-stream";

        const body = await response.body();

        return Option.some([reference, `data:${type};base64,${body.toString("base64")}`] as const);
      }).pipe(Effect.orElseSucceed(Option.none<readonly [string, string]>)),
    { concurrency: 8 },
  ).pipe(
    Effect.map((results) => {
      const replacements = results.flatMap(Option.toArray);

      const inlined = replacements.reduce(
        (current, [reference, data]) => current.split(escapeAttribute(reference)).join(data),
        html,
      );

      return { html: inlined, count: replacements.length };
    }),
  );

const ScrollMetrics = Schema.Struct({ scrollHeight: Schema.Finite, innerHeight: Schema.Finite });

/** Steps through the page from Node so lazy-loaded content renders, then returns to the top. */
const autoScroll = (page: Page, scroll: Scroll) =>
  Effect.gen(function* () {
    const metrics = yield* step("scroll", () =>
      page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      })),
    ).pipe(Effect.flatMap(decodeAt("scroll", ScrollMetrics)));

    const distance = Option.getOrElse(scroll.step, () =>
      Math.max(200, Math.round(metrics.innerHeight * 0.8)),
    );

    const end = Math.min(metrics.scrollHeight, scroll.maxDistance);

    for (let y = 0; y < end; y += distance) {
      yield* step("scroll", () => page.evaluate((top) => window.scrollTo(0, top), y));
      yield* Effect.sleep(scroll.delay);
    }

    yield* step("scroll", () => page.evaluate(() => window.scrollTo(0, 0)));
  });

/**
 * Paper's HTML importer does not derive aspect ratios, so `height: auto` images collapse.
 * Pin rendered heights for the capture; the returned effect restores them.
 */
const pinImageHeights = (page: Page) =>
  step("pin-images", () =>
    page.evaluate(() => {
      for (const image of document.querySelectorAll("img")) {
        const height = image.getBoundingClientRect().height;

        if (height === 0 || image.style.height !== "") continue;
        image.dataset["paperSnapPinned"] = "";
        image.style.setProperty("height", `${height}px`);
      }
    }),
  );

const unpinImageHeights = (page: Page) =>
  step("unpin-images", () =>
    page.evaluate(() => {
      for (const image of document.querySelectorAll<HTMLElement>("[data-paper-snap-pinned]")) {
        image.style.removeProperty("height");
        delete image.dataset["paperSnapPinned"];
      }
    }),
  ).pipe(Effect.ignore);

/** Navigates (when a URL is given), prepares the page, and serializes the selected element. */
export const capture = Effect.fn("Capture.capture")(function* (
  session: Browser.Session,
  url: Option.Option<string>,
  serializer: Extension.Serializer,
  settings: Settings,
) {
  const { page } = session;

  if (Option.isSome(url)) {
    yield* Effect.logInfo(`Loading ${url.value}`);
    yield* step("navigate", () =>
      page.goto(url.value, {
        waitUntil: settings.waitUntil,
        timeout: Duration.toMillis(settings.navigationTimeout),
      }),
    );
  }

  const idle = Duration.toMillis(settings.networkIdleTimeout);

  if (idle > 0)
    yield* step("network-idle", () => page.waitForLoadState("networkidle", { timeout: idle })).pipe(
      Effect.ignore,
    );

  if (Option.isSome(settings.waitFor)) {
    const selector = settings.waitFor.value;
    yield* step("wait-for", () =>
      page.waitForSelector(selector, { timeout: Duration.toMillis(settings.waitForTimeout) }),
    );
  }

  yield* Effect.forEach(settings.scripts, (script) => step("eval", () => page.evaluate(script)), {
    discard: true,
  });

  if (settings.scroll.enabled) {
    yield* autoScroll(page, settings.scroll);

    if (idle > 0)
      yield* step("network-idle", () =>
        page.waitForLoadState("networkidle", { timeout: idle }),
      ).pipe(Effect.ignore);
  }

  yield* Effect.sleep(settings.settle);
  yield* step("fonts", () => page.evaluate(() => document.fonts.ready.then(() => undefined)));

  const target = page.locator(settings.selector).first();
  yield* step("select", () =>
    target.waitFor({ state: "attached", timeout: Duration.toMillis(settings.waitForTimeout) }),
  );
  const stamp = `${yield* Clock.currentTimeMillis}`;
  yield* step("select", () =>
    target.evaluate((element, [name, value]) => element.setAttribute(name, value), [
      markAttribute,
      stamp,
    ] as const),
  );

  const rect = yield* step("measure", () =>
    target.evaluate((element) => {
      const bounds = element.getBoundingClientRect();

      return { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
    }),
  ).pipe(Effect.flatMap(decodeAt("measure", Rect)));

  yield* Effect.logInfo(`Capturing ${settings.selector} (${rect.width}×${rect.height})`);

  if (settings.pinImageHeights) yield* pinImageHeights(page);
  // The stamp is digits only, so the selector literal needs no escaping.
  const expression = `(${serializer.source})('[${markAttribute}="${stamp}"]')`;

  const result = yield* step("serialize", () => page.evaluate(expression)).pipe(
    Effect.timeout(settings.captureTimeout),
    Effect.mapError((error) =>
      Schema.is(CaptureError)(error)
        ? error
        : new CaptureError({ stage: "serialize", message: "Timed out" }),
    ),
    Effect.flatMap(decodeAt("serialize", CaptureResult)),
    Effect.ensuring(settings.pinImageHeights ? unpinImageHeights(page) : Effect.void),
  );

  if (result.status === "aborted")
    return yield* new CaptureError({ stage: "serialize", message: "Aborted" });

  if (result.status === "error")
    return yield* new CaptureError({ stage: "serialize", message: result.error });

  const pageUrl = page.url();

  const shouldInline =
    settings.inlineImages === "always" ||
    (settings.inlineImages === "auto" && isPrivateHost(pageUrl));

  const images = shouldInline
    ? yield* inlineImages(result.html, session.context, pageUrl, settings.imageTimeout)
    : { html: result.html, count: 0 };

  const title = yield* step("title", () => page.title());

  return {
    html: images.html,
    width: rect.width,
    height: rect.height,
    title: title === "" ? (URL.parse(pageUrl)?.host ?? pageUrl) : title,
    url: pageUrl,
    inlinedImages: images.count,
  } satisfies Snapshot;
});
