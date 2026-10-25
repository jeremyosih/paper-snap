/**
 * A job is one capture → one artboard. Flags describe a default job; positional URLs or a
 * manifest produce the actual list, each entry overriding any default field it sets.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const Dictionary = Schema.Record(Schema.String, Schema.String);

const ColorScheme = Schema.Literals(["light", "dark", "no-preference"]);

/** Every per-capture field a manifest entry may set; names mirror the CLI flags in camelCase. */
const Entry = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  selector: Schema.optionalKey(Schema.String),
  tab: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
  scale: Schema.optionalKey(Schema.Finite),
  colorScheme: Schema.optionalKey(ColorScheme),
  userAgent: Schema.optionalKey(Schema.String),
  locale: Schema.optionalKey(Schema.String),
  timezone: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Dictionary),
  storageState: Schema.optionalKey(Schema.String),
  localStorage: Schema.optionalKey(Dictionary),
  sessionStorage: Schema.optionalKey(Dictionary),
  cookies: Schema.optionalKey(Schema.Array(Schema.String)),
  clicks: Schema.optionalKey(Schema.Array(Schema.String)),
  eval: Schema.optionalKey(Schema.Array(Schema.String)),
  waitFor: Schema.optionalKey(Schema.String),
  settle: Schema.optionalKey(Schema.Finite),
  fullPage: Schema.optionalKey(Schema.Boolean),
  fileId: Schema.optionalKey(Schema.String),
  pageId: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.Finite),
  y: Schema.optionalKey(Schema.Finite),
  below: Schema.optionalKey(Schema.String),
  rightOf: Schema.optionalKey(Schema.String),
  replace: Schema.optionalKey(Schema.String),
});

type Entry = typeof Entry.Type;

const EntryList = Schema.Array(Schema.Union([Schema.String, Entry]));

const isEntryList = Schema.is(EntryList);

/** A bare URL string, an entry, a list of either, or `{ defaults, items }`. */
const Manifest = Schema.Union([
  EntryList,
  Schema.Struct({
    defaults: Schema.optionalKey(Entry),
    items: Schema.Array(Schema.Union([Schema.String, Entry])),
  }),
]);

class ManifestError extends Schema.TaggedError<ManifestError>()("Job.ManifestError", {
  message: Schema.String,
}) {}

/** The resolved description of one capture. */
export interface Job {
  readonly index: number;
  readonly url: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly selector: string;
  readonly tab: Option.Option<string>;
  readonly width: Option.Option<number>;
  readonly height: Option.Option<number>;
  readonly scale: number;
  readonly colorScheme: Option.Option<"light" | "dark" | "no-preference">;
  readonly userAgent: Option.Option<string>;
  readonly locale: Option.Option<string>;
  readonly timezone: Option.Option<string>;
  readonly headers: Readonly<Record<string, string>>;
  readonly storageState: Option.Option<string>;
  readonly localStorage: Readonly<Record<string, string>>;
  readonly sessionStorage: Readonly<Record<string, string>>;
  readonly cookies: ReadonlyArray<string>;
  readonly clicks: ReadonlyArray<string>;
  readonly scripts: ReadonlyArray<string>;
  readonly waitFor: Option.Option<string>;
  readonly settle: number;
  readonly fullPage: boolean;
  readonly fileId: Option.Option<string>;
  readonly pageId: Option.Option<string>;
  readonly x: Option.Option<number>;
  readonly y: Option.Option<number>;
  readonly below: Option.Option<string>;
  readonly rightOf: Option.Option<string>;
  readonly replace: Option.Option<string>;
}

/** Whether the job pins its own placement, so batch layout leaves it alone. */
export const isPlaced = (job: Job) =>
  Option.isSome(job.x) ||
  Option.isSome(job.y) ||
  Option.isSome(job.below) ||
  Option.isSome(job.rightOf) ||
  Option.isSome(job.replace);

const override = <A>(value: A | undefined, fallback: Option.Option<A>) =>
  value === undefined ? fallback : Option.some(value);

/** Applies a manifest entry over a default job. */
const apply = (base: Job, entry: Entry): Job => ({
  ...base,
  url: override(entry.url, base.url),
  name: override(entry.name, base.name),
  selector: entry.selector ?? base.selector,
  tab: override(entry.tab, base.tab),
  width: override(entry.width, base.width),
  height: override(entry.height, base.height),
  scale: entry.scale ?? base.scale,
  colorScheme: override(entry.colorScheme, base.colorScheme),
  userAgent: override(entry.userAgent, base.userAgent),
  locale: override(entry.locale, base.locale),
  timezone: override(entry.timezone, base.timezone),
  headers: { ...base.headers, ...entry.headers },
  storageState: override(entry.storageState, base.storageState),
  localStorage: { ...base.localStorage, ...entry.localStorage },
  sessionStorage: { ...base.sessionStorage, ...entry.sessionStorage },
  cookies: [...base.cookies, ...(entry.cookies ?? [])],
  clicks: entry.clicks ?? base.clicks,
  scripts: [...base.scripts, ...(entry.eval ?? [])],
  waitFor: override(entry.waitFor, base.waitFor),
  settle: entry.settle ?? base.settle,
  fullPage: entry.fullPage ?? base.fullPage,
  fileId: override(entry.fileId, base.fileId),
  pageId: override(entry.pageId, base.pageId),
  x: override(entry.x, base.x),
  y: override(entry.y, base.y),
  below: override(entry.below, base.below),
  rightOf: override(entry.rightOf, base.rightOf),
  replace: override(entry.replace, base.replace),
});

/** Paths like `/pricing` resolve against the base URL (or the first absolute URL in the run). */
const resolveUrls = (jobs: ReadonlyArray<Job>, baseUrl: Option.Option<string>) =>
  Effect.gen(function* () {
    const base = Option.orElse(baseUrl, () =>
      Option.fromNullishOr(
        jobs.flatMap((job) => Option.toArray(job.url)).find((url) => URL.canParse(url)),
      ),
    );

    return yield* Effect.forEach(jobs, (job) => {
      if (Option.isNone(job.url) || URL.canParse(job.url.value)) return Effect.succeed(job);

      const relative = job.url.value;

      return Option.match(base, {
        onNone: () =>
          Effect.fail(
            new ManifestError({
              message: `"${relative}" is not a full URL; pass --base-url or start with an absolute URL`,
            }),
          ),
        onSome: (origin) =>
          Effect.succeed({ ...job, url: Option.some(new URL(relative, origin).href) }),
      });
    });
  });

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

/** Expands positional URLs or a manifest into jobs; with neither, the default job runs once. */
export const expand = Effect.fn("Job.expand")(function* (
  base: Job,
  urls: ReadonlyArray<string>,
  manifest: Option.Option<string>,
  baseUrl: Option.Option<string>,
) {
  const entries: ReadonlyArray<string | Entry> = Option.isSome(manifest)
    ? yield* decodeManifest(manifest.value).pipe(
        Effect.mapError(
          (error) => new ManifestError({ message: `Invalid manifest: ${error.message}` }),
        ),
        Effect.map((decoded) =>
          isEntryList(decoded)
            ? decoded
            : decoded.items.map((item) =>
                Predicate.isString(item)
                  ? { ...decoded.defaults, url: item }
                  : { ...decoded.defaults, ...item },
              ),
        ),
      )
    : urls;

  if (entries.length > 1 && Option.isSome(base.replace)) {
    return yield* new ManifestError({
      message: "--replace takes a single capture; set replace per manifest item instead",
    });
  }

  // Placement flags anchor the first capture; the rest follow --layout unless an entry pins its own.
  const following: Job = {
    ...base,
    x: Option.none(),
    y: Option.none(),
    below: Option.none(),
    rightOf: Option.none(),
  };

  const jobs =
    entries.length === 0
      ? [base]
      : entries.map((entry, index) =>
          apply(
            { ...(index === 0 ? base : following), index },
            Predicate.isString(entry) ? { url: entry } : entry,
          ),
        );

  return yield* resolveUrls(jobs, baseUrl);
});
