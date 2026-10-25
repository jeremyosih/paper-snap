/**
 * Page passes that make a capture import cleanly into Paper. Each one rewrites the live DOM just
 * before serialization and returns how to undo it, so attached browsers are left as they were.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BrowserContext, Locator, Page } from "playwright-core";

export interface FullPage {
  readonly enabled: boolean;
  /** Upper bound for the grown viewport, so endlessly growing scrollers terminate. */
  readonly maxHeight: number;
  readonly settle: Duration.Duration;
}

export interface Warnings {
  readonly emptySvgs: number;
  readonly unresolvedSprites: number;
  readonly clippedScrollContainers: number;
  readonly unresolvedImages: number;
  readonly lostColspans: number;
}

export class PrepareError extends Schema.TaggedError<PrepareError>()("Prepare.PrepareError", {
  stage: Schema.String,
  message: Schema.String,
}) {}

const step = <A>(stage: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new PrepareError({
        stage,
        message:
          error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error),
      }),
  });

const decodeAt =
  <A>(stage: string, schema: Schema.Decoder<A>) =>
  <I>(value: I) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) => new PrepareError({ stage, message: error.message })),
    );

declare global {
  interface Window {
    /** Undo log kept on the page so restoration survives across separate evaluate calls. */
    __paperSnapRestore?: Array<() => void>;
  }
}

/** Runs and clears every undo function the passes registered. */
export const restore = (page: Page) =>
  step("restore", () =>
    page.evaluate(() => {
      for (const undo of (window.__paperSnapRestore ?? []).reverse()) undo();
      delete window.__paperSnapRestore;
    }),
  ).pipe(Effect.ignore);

const Counts = Schema.Struct({ resolved: Schema.Finite, unresolved: Schema.Finite });

/**
 * External sprites (`<use href="/sprite.svg#id">`) serialize as empty SVGs because the serializer
 * only follows same-document references. Fetch each sprite with the page's cookies, then replace
 * every external `<use>` with the symbol's shapes, baking in the computed fill and stroke.
 */
export const inlineSprites = Effect.fn("Prepare.inlineSprites")(function* (
  page: Page,
  context: BrowserContext,
  timeout: Duration.Duration,
) {
  const urls = yield* step("sprites", () =>
    page.evaluate(() => {
      const found = new Set<string>();

      for (const use of document.querySelectorAll("use")) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";

        if (href === "" || href.startsWith("#")) continue;

        const url = new URL(href, document.baseURI);
        url.hash = "";
        found.add(url.href);
      }

      return [...found];
    }),
  ).pipe(Effect.flatMap(decodeAt("sprites", Schema.Array(Schema.String))));

  if (urls.length === 0) return { resolved: 0, unresolved: 0 };

  const sprites = yield* Effect.forEach(
    urls,
    (url) =>
      step("sprites", async () => {
        const response = await context.request.get(url, { timeout: Duration.toMillis(timeout) });

        return response.ok() ? [[url, await response.text()] as const] : [];
      }).pipe(Effect.orElseSucceed(() => [])),
    { concurrency: 8 },
  );

  return yield* step("sprites", () =>
    page.evaluate((entries) => {
      const namespace = "http://www.w3.org/2000/svg";
      const parser = new DOMParser();

      const documents = new Map(
        entries.map(([url, text]) => [url, parser.parseFromString(text, "image/svg+xml")]),
      );

      const log = (window.__paperSnapRestore ??= []);
      let resolved = 0;
      let unresolved = 0;

      for (const use of document.querySelectorAll("use")) {
        const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";

        if (href === "" || href.startsWith("#")) continue;

        const url = new URL(href, document.baseURI);
        const id = decodeURIComponent(url.hash.slice(1));
        url.hash = "";
        const symbol = documents.get(url.href)?.getElementById(id);
        const svg = use.ownerSVGElement;

        if (symbol === null || symbol === undefined || svg === null) {
          unresolved++;
          continue;
        }

        const group = document.createElementNS(namespace, "g");

        for (const child of symbol.childNodes) group.append(document.importNode(child, true));
        use.replaceWith(group);
        log.push(() => group.replaceWith(use));

        const viewBox = symbol.getAttribute("viewBox");

        if (viewBox !== null && !svg.hasAttribute("viewBox")) {
          svg.setAttribute("viewBox", viewBox);
          log.push(() => svg.removeAttribute("viewBox"));
        }

        // Icons usually colour themselves with `fill: currentColor` from page CSS; freeze it.
        for (const graphic of group.querySelectorAll("*")) {
          const style = getComputedStyle(graphic);

          if (!graphic.hasAttribute("fill")) graphic.setAttribute("fill", style.fill);

          if (!graphic.hasAttribute("stroke") && style.stroke !== "none")
            graphic.setAttribute("stroke", style.stroke);
        }

        resolved++;
      }

      return { resolved, unresolved };
    }, sprites.flat()),
  ).pipe(Effect.flatMap(decodeAt("sprites", Counts)));
});

/**
 * Paper lays a `colspan` cell out one column wide, and a single frozen row skews its column
 * math for the rest of the table. Tables holding one are flattened into flex rows and columns
 * with every cell at its rendered width, so they import exactly as rendered.
 */
export const fixColspans = (page: Page) =>
  step("colspans", () =>
    page.evaluate(() => {
      const log = (window.__paperSnapRestore ??= []);
      const tables = new Set<HTMLTableElement>();

      for (const cell of document.querySelectorAll<HTMLTableCellElement>("td, th")) {
        const table = cell.closest("table");

        if (cell.colSpan > 1 && table !== null) tables.add(table);
      }

      for (const table of tables) {
        const rows = [...table.rows];

        const sections = [
          ...table.querySelectorAll(":scope > thead, :scope > tbody, :scope > tfoot"),
        ];

        // Measure everything before the first style change moves anything.
        const tableWidth = table.getBoundingClientRect().width;
        const rowWidths = rows.map((row) => row.getBoundingClientRect().width);

        const cellWidths = rows.map((row) =>
          [...row.cells].map((cell) => cell.getBoundingClientRect().width),
        );

        const touched = [table, ...sections, ...rows, ...rows.flatMap((row) => [...row.cells])];
        const before = touched.map((element) => element.getAttribute("style"));

        log.push(() =>
          touched.forEach((element, index) => {
            const style = before[index];

            if (style === null || style === undefined) element.removeAttribute("style");
            else element.setAttribute("style", style);
          }),
        );

        table.style.setProperty("display", "flex");
        table.style.setProperty("flex-direction", "column");
        table.style.setProperty("width", `${tableWidth}px`);

        for (const section of sections) {
          if (!(section instanceof HTMLElement)) continue;

          section.style.setProperty("display", "flex");
          section.style.setProperty("flex-direction", "column");
        }

        rows.forEach((row, rowIndex) => {
          row.style.setProperty("display", "flex");
          row.style.setProperty("width", `${rowWidths[rowIndex] ?? tableWidth}px`);

          [...row.cells].forEach((cell, cellIndex) => {
            cell.style.setProperty("display", "block");
            cell.style.setProperty("flex", "none");
            cell.style.setProperty("box-sizing", "border-box");
            cell.style.setProperty("width", `${cellWidths[rowIndex]?.[cellIndex] ?? 0}px`);
          });
        });
      }

      return tables.size;
    }),
  ).pipe(Effect.flatMap(decodeAt("colspans", Schema.Finite)));

const Overflow = Schema.Struct({ extra: Schema.Finite, containers: Schema.Finite });

/** How far the deepest internal scroll container overflows, and how many are clipped. */
const measureOverflow = (page: Page) =>
  step("full-page", () =>
    page.evaluate(() => {
      let extra = 0;
      let containers = 0;

      for (const element of document.querySelectorAll("*")) {
        if (element === document.documentElement || element === document.body) continue;

        const overflowY = getComputedStyle(element).overflowY;

        if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") continue;

        const hidden = element.scrollHeight - element.clientHeight;

        if (hidden > 1 && element.clientHeight > 0) {
          extra = Math.max(extra, hidden);
          containers++;
        }
      }

      return { extra, containers };
    }),
  ).pipe(Effect.flatMap(decodeAt("full-page", Overflow)));

const Size = Schema.Struct({ width: Schema.Finite, height: Schema.Finite });

/**
 * App shells (`h-screen` + an `overflow: auto` main) clip everything below the fold. Grow the
 * viewport until no internal scroll container overflows, so the capture holds the whole screen.
 * Returns the number of containers still clipped and how to restore the viewport.
 */
export const growToFullPage = Effect.fn("Prepare.growToFullPage")(function* (
  page: Page,
  options: FullPage,
) {
  const original = page.viewportSize();

  const start = yield* step("full-page", () =>
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ).pipe(Effect.flatMap(decodeAt("full-page", Size)));

  let height = start.height;
  let overflow = yield* measureOverflow(page);

  for (let round = 0; options.enabled && overflow.extra > 0 && round < 8; round++) {
    const next = Math.min(options.maxHeight, height + overflow.extra);

    if (next <= height) break;

    height = next;
    yield* step("full-page", () => page.setViewportSize({ width: start.width, height }));
    yield* Effect.sleep(options.settle);
    overflow = yield* measureOverflow(page);
  }

  const grown = height !== start.height;

  if (grown) yield* Effect.logInfo(`Grew the viewport to ${height}px to unclip scroll containers`);

  const clearOverride = step("full-page", async () => {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.detach();
  }).pipe(Effect.ignore);

  // An attached tab may have had no emulated viewport; then drop the override instead.
  const reset = !grown
    ? Effect.void
    : original === null
      ? clearOverride
      : step("full-page", () => page.setViewportSize(original)).pipe(Effect.ignore);

  return { clipped: overflow.containers, reset };
});

const PageWarnings = Schema.Struct({
  emptySvgs: Schema.Finite,
  unresolvedImages: Schema.Finite,
  colspans: Schema.Finite,
});

/** Counts what will import badly inside the captured element. */
export const scan = (target: Locator) =>
  step("warnings", () =>
    target.evaluate((root) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();

        return rect.width > 0 && rect.height > 0 && element.checkVisibility();
      };

      const drawable =
        "path, circle, rect, ellipse, line, polyline, polygon, text, image, foreignObject, use[href^='#']";

      return {
        emptySvgs: [...root.querySelectorAll("svg")].filter(
          (svg) => visible(svg) && svg.querySelector(drawable) === null,
        ).length,
        unresolvedImages: [...root.querySelectorAll("img")].filter(
          (image) => visible(image) && image.complete && image.naturalWidth === 0,
        ).length,
        colspans: [...root.querySelectorAll<HTMLTableCellElement>("td, th")].filter(
          (cell) => cell.colSpan > 1 && getComputedStyle(cell).display === "table-cell",
        ).length,
      };
    }),
  ).pipe(Effect.flatMap(decodeAt("warnings", PageWarnings)));
