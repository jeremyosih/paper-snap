/**
 * Obtains the Paper Snapshot serializer from the official Chrome extension.
 *
 * The extension is downloaded from the Chrome Web Store on first use and cached; its
 * capture function is located by behaviour, not by its minified name, so new extension
 * releases keep working. No Paper code ships with paper-snapshot.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { unzipSync } from "fflate";
import * as vm from "node:vm";

/** Paper Snapshot on the Chrome Web Store. */
export const paperSnapshotId = "lidfahaahiogmnlccifabccgplofocck";

/** Strings only the extension's DOM serializer contains. */
const serializerMarkers = ["x-paper-style-reference", "paper-snapshot-original-tag"];

export interface Serializer {
  /** Source of a function `(selector: string) => Promise<CaptureResult>` that runs in the page. */
  readonly source: string;
  readonly version: string;
  /** Where the extension came from: a cache path, a download, or a user-supplied path. */
  readonly origin: string;
}

export interface Settings {
  readonly extensionId: string;
  /** A .crx, .zip, unpacked extension directory, or a single .js file. */
  readonly localPath: Option.Option<string>;
  readonly cacheDir: string;
  readonly refresh: boolean;
}

class ExtensionError extends Schema.TaggedError<
  ExtensionError,
  { readonly brand: unique symbol }
>()("Extension.ExtensionError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly serializer: (settings: Settings) => Effect.Effect<Serializer, ExtensionError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "paper-snapshot/extension/Service",
) {}

const Manifest = Schema.Struct({ version: Schema.String });

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const textDecoder = new TextDecoder();

/** CRX3: "Cr24", format version, header length, header, then a plain zip archive. */
const zipPayload = (bytes: Uint8Array) => {
  const isCrx = bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34;

  if (!isCrx) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint32(4, true);

  const headerEnd =
    format === 2
      ? 16 + view.getUint32(8, true) + view.getUint32(12, true)
      : 12 + view.getUint32(8, true);

  return bytes.subarray(headerEnd);
};

/** A stand-in for the `chrome` extension API: every property access and call yields another. */
const inertChromeApi = (): (() => void) =>
  new Proxy(() => {}, { get: () => inertChromeApi(), apply: () => inertChromeApi() });

/**
 * Runs extension scripts in an isolated VM context and returns the source of the function
 * that contains every serializer marker. Script top-level code only registers listeners on
 * the inert `chrome` stand-in, so evaluating it has no effect.
 */
const findSerializer = (scripts: ReadonlyArray<string>) => {
  for (const script of scripts) {
    if (!serializerMarkers.every((marker) => script.includes(marker))) continue;
    const sandbox = vm.createContext({ chrome: inertChromeApi() });
    sandbox["self"] = sandbox;
    vm.runInContext(script, sandbox, { timeout: 2_000 });

    // Script-level function declarations become properties of the context's global object.
    for (const name of Object.keys(sandbox)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;

      const source = String(
        vm.runInContext(
          `typeof ${name} === "function" ? Function.prototype.toString.call(${name}) : ""`,
          sandbox,
        ),
      );

      if (serializerMarkers.every((marker) => source.includes(marker))) return Option.some(source);
    }
  }

  return Option.none<string>();
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;

    const fail = (message: string) => new ExtensionError({ message });

    const unpackArchive = Effect.fn("Extension.unpackArchive")(function* (bytes: Uint8Array) {
      const files = yield* Effect.try({
        try: () => unzipSync(zipPayload(bytes)),
        catch: () => fail("The extension archive is not a valid CRX or zip file"),
      });

      const manifest = files["manifest.json"];

      if (manifest === undefined) return yield* fail("The extension archive has no manifest.json");

      const { version } = yield* decodeManifest(textDecoder.decode(manifest)).pipe(
        Effect.mapError(() => fail("The extension manifest has no version")),
      );

      const scripts = Object.entries(files).flatMap(([name, content]) =>
        name.endsWith(".js") ? [{ name, text: textDecoder.decode(content) }] : [],
      );

      return { version, scripts };
    });

    const readDirectory = Effect.fn("Extension.readDirectory")(function* (directory: string) {
      const manifest = yield* fs
        .readFileString(path.join(directory, "manifest.json"))
        .pipe(Effect.mapError(() => fail(`${directory} has no manifest.json`)));

      const { version } = yield* decodeManifest(manifest).pipe(
        Effect.mapError(() => fail("The extension manifest has no version")),
      );

      const names = yield* fs
        .readDirectory(directory, { recursive: true })
        .pipe(Effect.mapError((error) => fail(`Could not read ${directory}: ${error.message}`)));

      const scripts = yield* Effect.forEach(
        names.filter((name) => name.endsWith(".js")),
        (name) =>
          fs.readFileString(path.join(directory, name)).pipe(
            Effect.map((text) => ({ name, text })),
            Effect.mapError((error) => fail(`Could not read ${name}: ${error.message}`)),
          ),
      );

      return { version, scripts };
    });

    const readLocal = Effect.fn("Extension.readLocal")(function* (location: string) {
      const info = yield* fs
        .stat(location)
        .pipe(Effect.mapError(() => fail(`${location} does not exist`)));

      if (info.type === "Directory") return yield* readDirectory(location);

      if (location.endsWith(".js")) {
        const text = yield* fs
          .readFileString(location)
          .pipe(Effect.mapError((error) => fail(`Could not read ${location}: ${error.message}`)));

        return { version: "local", scripts: [{ name: path.basename(location), text }] };
      }

      const bytes = yield* fs
        .readFile(location)
        .pipe(Effect.mapError((error) => fail(`Could not read ${location}: ${error.message}`)));

      return yield* unpackArchive(bytes);
    });

    const download = Effect.fn("Extension.download")(function* (extensionId: string) {
      const url =
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0" +
        `&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc`;

      yield* Effect.logInfo(`Downloading the Paper Snapshot extension (${extensionId})`);

      const buffer = yield* http.get(url).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.timeout("60 seconds"),
        Effect.mapError((error) => fail(`Downloading the extension failed: ${error.message}`)),
      );

      return new Uint8Array(buffer);
    });

    const extract = (
      unpacked: {
        readonly version: string;
        readonly scripts: ReadonlyArray<{ readonly text: string }>;
      },
      origin: string,
    ) =>
      Effect.try({
        try: () => findSerializer(unpacked.scripts.map((script) => script.text)),
        catch: (error) => fail(`Evaluating the extension failed: ${String(error)}`),
      }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                fail(
                  `Extension ${unpacked.version} has no recognisable serializer; Paper may have changed it`,
                ),
              ),
            onSome: (source) => Effect.succeed({ source, version: unpacked.version, origin }),
          }),
        ),
      );

    const serializer = Effect.fn("Extension.serializer")(function* (settings: Settings) {
      if (Option.isSome(settings.localPath)) {
        return yield* extract(yield* readLocal(settings.localPath.value), settings.localPath.value);
      }

      const cached = path.join(settings.cacheDir, `${settings.extensionId}.crx`);
      const hasCache = yield* fs.exists(cached).pipe(Effect.orElseSucceed(() => false));

      if (hasCache && !settings.refresh) {
        const fromCache = yield* readLocal(cached).pipe(
          Effect.flatMap((unpacked) => extract(unpacked, cached)),
          Effect.option,
        );

        if (Option.isSome(fromCache)) return fromCache.value;
      }

      const bytes = yield* download(settings.extensionId);
      const unpacked = yield* unpackArchive(bytes);
      const result = yield* extract(unpacked, `chrome web store (${settings.extensionId})`);
      yield* fs.makeDirectory(settings.cacheDir, { recursive: true }).pipe(
        Effect.andThen(fs.writeFile(cached, bytes)),
        Effect.catch((error) =>
          Effect.logWarning(`Could not cache the extension: ${error.message}`),
        ),
      );

      return result;
    });

    return Service.of({ serializer });
  }),
);
