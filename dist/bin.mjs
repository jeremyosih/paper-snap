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
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { chromium } from "playwright-core";
import * as Config from "effect/Config";
import * as Argument from "effect/unstable/cli/Argument";
import * as Flag from "effect/unstable/cli/Flag";
import * as Clock from "effect/Clock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { unzipSync } from "fflate";
import * as vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
//#region src/browser.ts
/** Acquires a Chromium page: a launched local browser, a CDP endpoint, or agent-browser's session. */
const Source = Data.taggedEnum();
var BrowserError = class extends Schema.TaggedError()("Browser.BrowserError", { message: Schema.String }) {};
var Service$2 = class extends Context.Service()("paper-snap/browser/Service") {};
const defaultViewport = {
	width: 1440,
	height: 900
};
const installedBrowsersByPlatform = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		"/usr/bin/brave-browser",
		"/snap/bin/chromium"
	],
	win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
};
const installedBrowsers = (platform) => platform === "darwin" || platform === "linux" || platform === "win32" ? installedBrowsersByPlatform[platform] : [];
const firstLine = (error) => error.message.split("\n")[0] ?? error.message;
const toBrowserError = (action) => (error) => new BrowserError({ message: `${action}: ${firstLine(error)}` });
const attempt = (action, run) => Effect.tryPromise({
	try: run,
	catch: (error) => toBrowserError(action)(error instanceof Error ? error : new Error(String(error)))
});
const cdpUrlPattern = /(?:wss?|https?):\/\/\S+/;
const layer$2 = Layer.effect(Service$2, Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const run = (command, args, timeout) => spawner.string(ChildProcess.make(command, args)).pipe(Effect.timeout(timeout), Effect.mapError((error) => new BrowserError({ message: `\`${command} ${args.join(" ")}\` failed: ${error.message}` })));
	const close = (browser) => Effect.promise(() => browser.close()).pipe(Effect.ignore);
	const downloadChromium = Effect.fn("Browser.downloadChromium")(function* (timeout) {
		const cli = yield* path.fromFileUrl(new URL(import.meta.resolve("playwright-core/cli.js"))).pipe(Effect.mapError(() => new BrowserError({ message: "Could not locate playwright-core's CLI" })));
		yield* Effect.logWarning("No installed Chrome found; downloading headless Chromium (one time)");
		yield* run(process.execPath, [
			cli,
			"install",
			"chromium-headless-shell"
		], timeout);
	});
	const launch = Effect.fn("Browser.launch")(function* (source, timeout) {
		const requested = source.executablePath;
		const known = installedBrowsers(process.platform);
		const candidates = Option.match(requested, {
			onNone: () => known,
			onSome: (explicit) => [explicit]
		});
		const options = {
			headless: !source.headed,
			args: [...source.args],
			timeout: Duration.toMillis(timeout)
		};
		for (const executablePath of candidates) {
			if (!(yield* fs.exists(executablePath).pipe(Effect.orElseSucceed(() => false)))) continue;
			const browser = yield* attempt(`Launching ${executablePath}`, () => chromium.launch({
				...options,
				executablePath
			})).pipe(Effect.option);
			if (Option.isSome(browser)) return {
				browser: browser.value,
				origin: path.basename(executablePath)
			};
		}
		if (Option.isSome(requested)) return yield* new BrowserError({ message: `Could not launch the browser at ${requested.value}` });
		const bundled = yield* attempt("Launching Playwright's Chromium", () => chromium.launch(options)).pipe(Effect.option);
		if (Option.isSome(bundled)) return {
			browser: bundled.value,
			origin: "playwright chromium"
		};
		if (!source.download) return yield* new BrowserError({ message: "No Chromium-based browser found. Install Chrome, pass --browser <path>, or allow --download-browser" });
		yield* downloadChromium(Duration.minutes(10));
		return {
			browser: yield* attempt("Launching downloaded Chromium", () => chromium.launch(options)),
			origin: "playwright chromium"
		};
	});
	const agentBrowserEndpoint = Effect.fn("Browser.agentBrowserEndpoint")(function* (source, timeout) {
		const sessionArgs = Option.match(source.session, {
			onNone: () => [],
			onSome: (name) => ["--session", name]
		});
		const output = yield* run(source.bin, [
			...sessionArgs,
			"get",
			"cdp-url"
		], timeout);
		const endpoint = cdpUrlPattern.exec(output)?.[0];
		if (endpoint === void 0) return yield* new BrowserError({ message: `agent-browser returned no CDP URL (is a session open?): ${output.trim() || "<empty>"}` });
		return endpoint;
	});
	const agentBrowserUrl = Effect.fn("Browser.agentBrowserUrl")(function* (source, timeout) {
		const sessionArgs = Option.match(source.session, {
			onNone: () => [],
			onSome: (name) => ["--session", name]
		});
		const output = yield* run(source.bin, [
			...sessionArgs,
			"get",
			"url"
		], timeout);
		const url = /(?:https?|file):\/\/\S+/.exec(output)?.[0];
		if (url === void 0) return yield* new BrowserError({ message: "agent-browser has no active URL" });
		return url;
	});
	const contextOptions = (settings) => ({
		viewport: Option.getOrElse(settings.viewport, () => defaultViewport),
		deviceScaleFactor: settings.scale,
		extraHTTPHeaders: settings.headers,
		...Option.match(settings.colorScheme, {
			onNone: () => ({}),
			onSome: (colorScheme) => ({ colorScheme })
		}),
		...Option.match(settings.userAgent, {
			onNone: () => ({}),
			onSome: (userAgent) => ({ userAgent })
		}),
		...Option.match(settings.locale, {
			onNone: () => ({}),
			onSome: (locale) => ({ locale })
		}),
		...Option.match(settings.timezone, {
			onNone: () => ({}),
			onSome: (timezoneId) => ({ timezoneId })
		}),
		...Option.match(settings.storageState, {
			onNone: () => ({}),
			onSome: (storageState) => ({ storageState })
		})
	});
	const openLaunched = Effect.fn("Browser.openLaunched")(function* (source, settings) {
		const { browser, origin } = yield* Effect.acquireRelease(launch(source, settings.connectTimeout), ({ browser }) => close(browser));
		const context = yield* attempt("Creating browser context", () => browser.newContext(contextOptions(settings)));
		return {
			page: yield* attempt("Opening tab", () => context.newPage()),
			context,
			origin
		};
	});
	/** The tab the user or agent is looking at: a URL/title match, else the visible tab, else the last. */
	const pickTab = Effect.fn("Browser.pickTab")(function* (pages, match) {
		if (Option.isSome(match)) {
			const needle = match.value;
			for (const page of pages) {
				const title = yield* attempt("Reading tab title", () => page.title()).pipe(Effect.timeout("2 seconds"), Effect.orElseSucceed(() => ""));
				if (page.url().includes(needle) || title.includes(needle)) return page;
			}
			return yield* new BrowserError({ message: `No open tab matches --tab ${needle}` });
		}
		const content = pages.filter((page) => /^(?:https?|file):/.test(page.url()));
		for (const page of content) if (yield* attempt("Probing tab", () => page.evaluate(() => document.visibilityState === "visible")).pipe(Effect.timeout("2 seconds"), Effect.orElseSucceed(() => false))) return page;
		return content.at(-1) ?? pages.at(-1);
	});
	const openAttached = Effect.fn("Browser.openAttached")(function* (endpoint, origin, settings, freshTab) {
		const context = (yield* attempt(`Connecting to ${endpoint}`, () => chromium.connectOverCDP(endpoint, { timeout: Duration.toMillis(settings.connectTimeout) }))).contexts()[0];
		if (context === void 0) return yield* new BrowserError({ message: `${endpoint} has no browser context` });
		const page = freshTab ? yield* Effect.acquireRelease(attempt("Opening tab", () => context.newPage()), (tab) => Effect.promise(() => tab.close()).pipe(Effect.ignore)) : yield* pickTab(context.pages(), settings.tab);
		if (page === void 0) return yield* new BrowserError({ message: `${endpoint} has no open tab` });
		yield* Effect.forEach(Option.toArray(settings.viewport), (viewport) => attempt("Resizing viewport", () => page.setViewportSize(viewport)));
		yield* Effect.forEach(Option.toArray(settings.colorScheme), (colorScheme) => attempt("Emulating color scheme", () => page.emulateMedia({ colorScheme })));
		if (Object.keys(settings.headers).length > 0) yield* attempt("Setting headers", () => page.setExtraHTTPHeaders(settings.headers));
		return {
			page,
			context,
			origin
		};
	});
	const open = Effect.fn("Browser.open")(function* (source, settings, freshTab) {
		return yield* Source.$match(source, {
			Launch: (launchSource) => openLaunched(launchSource, settings),
			Attach: ({ endpoint }) => openAttached(endpoint, endpoint, settings, freshTab),
			Playwriter: ({ endpoint }) => openAttached(endpoint, "playwriter", settings, freshTab),
			AgentBrowser: (agentSource) => Effect.gen(function* () {
				const endpoint = yield* agentBrowserEndpoint(agentSource, settings.connectTimeout);
				const tab = Option.isSome(settings.tab) ? settings.tab : yield* agentBrowserUrl(agentSource, settings.connectTimeout).pipe(Effect.option);
				return yield* openAttached(endpoint, "agent-browser", {
					...settings,
					tab
				}, freshTab);
			})
		});
	});
	return Service$2.of({ open });
}));
//#endregion
//#region src/capture.ts
/** Loads and prepares a page, then serializes an element with Paper's snapshot serializer. */
var CaptureError = class extends Schema.TaggedError()("Capture.CaptureError", {
	stage: Schema.String,
	message: Schema.String
}) {};
const CaptureResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("success"),
		html: Schema.String
	}),
	Schema.Struct({ status: Schema.Literal("aborted") }),
	Schema.Struct({
		status: Schema.Literal("error"),
		error: Schema.String
	})
]);
const Rect = Schema.Struct({
	width: Schema.Finite,
	height: Schema.Finite
});
const step = (stage, run) => Effect.tryPromise({
	try: run,
	catch: (error) => new CaptureError({
		stage,
		message: error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error)
	})
});
/** Decodes a page result, attributing failures to a pipeline stage. */
const decodeAt = (stage, schema) => (value) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((error) => new CaptureError({
	stage,
	message: error.message
})));
/** Marks the target so the serializer can find it, even inside shadow roots. */
const markAttribute = "data-paper-element-picker";
const privateHost = /^(?:localhost|.*\.localhost|.*\.local|.*\.test|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/;
const isPrivateHost = (url) => {
	const parsed = URL.parse(url);
	return parsed !== null && privateHost.test(parsed.hostname);
};
const unescapeAttribute = (value) => value.replaceAll("&quot;", "\"").replaceAll("&amp;", "&");
const escapeAttribute = (value) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");
const imageReferences = (html) => {
	const references = /* @__PURE__ */ new Set();
	for (const match of html.matchAll(/\bsrc="([^"]+)"/g)) references.add(unescapeAttribute(match[1] ?? ""));
	for (const match of html.matchAll(/url\(\s*(?:&quot;|["']?)(.*?)(?:&quot;|["']?)\s*\)/g)) references.add(unescapeAttribute(match[1] ?? ""));
	references.delete("");
	return [...references].filter((reference) => !reference.startsWith("data:"));
};
/** Paper cannot reach private hosts, so their assets travel inside the snapshot as data URIs. */
const inlineImages = (html, context, base, timeout) => Effect.forEach(imageReferences(html), (reference) => step("inline-images", async () => {
	const response = await context.request.get(new URL(reference, base).href, { timeout: Duration.toMillis(timeout) });
	if (!response.ok()) return Option.none();
	const type = response.headers()["content-type"]?.split(";")[0] ?? "application/octet-stream";
	const body = await response.body();
	return Option.some([reference, `data:${type};base64,${body.toString("base64")}`]);
}).pipe(Effect.orElseSucceed(Option.none)), { concurrency: 8 }).pipe(Effect.map((results) => {
	const replacements = results.flatMap(Option.toArray);
	return {
		html: replacements.reduce((current, [reference, data]) => current.split(escapeAttribute(reference)).join(data), html),
		count: replacements.length
	};
}));
const ScrollMetrics = Schema.Struct({
	scrollHeight: Schema.Finite,
	innerHeight: Schema.Finite
});
/** Steps through the page from Node so lazy-loaded content renders, then returns to the top. */
const autoScroll = (page, scroll) => Effect.gen(function* () {
	const metrics = yield* step("scroll", () => page.evaluate(() => ({
		scrollHeight: document.documentElement.scrollHeight,
		innerHeight: window.innerHeight
	}))).pipe(Effect.flatMap(decodeAt("scroll", ScrollMetrics)));
	const distance = Option.getOrElse(scroll.step, () => Math.max(200, Math.round(metrics.innerHeight * .8)));
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
const pinImageHeights = (page) => step("pin-images", () => page.evaluate(() => {
	for (const image of document.querySelectorAll("img")) {
		const height = image.getBoundingClientRect().height;
		if (height === 0 || image.style.height !== "") continue;
		image.dataset["paperSnapPinned"] = "";
		image.style.setProperty("height", `${height}px`);
	}
}));
const unpinImageHeights = (page) => step("unpin-images", () => page.evaluate(() => {
	for (const image of document.querySelectorAll("[data-paper-snap-pinned]")) {
		image.style.removeProperty("height");
		delete image.dataset["paperSnapPinned"];
	}
})).pipe(Effect.ignore);
/** Navigates (when a URL is given), prepares the page, and serializes the selected element. */
const capture = Effect.fn("Capture.capture")(function* (session, url, serializer, settings) {
	const { page } = session;
	if (Option.isSome(url)) {
		yield* Effect.logInfo(`Loading ${url.value}`);
		yield* step("navigate", () => page.goto(url.value, {
			waitUntil: settings.waitUntil,
			timeout: Duration.toMillis(settings.navigationTimeout)
		}));
	}
	const idle = Duration.toMillis(settings.networkIdleTimeout);
	if (idle > 0) yield* step("network-idle", () => page.waitForLoadState("networkidle", { timeout: idle })).pipe(Effect.ignore);
	if (Option.isSome(settings.waitFor)) {
		const selector = settings.waitFor.value;
		yield* step("wait-for", () => page.waitForSelector(selector, { timeout: Duration.toMillis(settings.waitForTimeout) }));
	}
	yield* Effect.forEach(settings.scripts, (script) => step("eval", () => page.evaluate(script)), { discard: true });
	if (settings.scroll.enabled) {
		yield* autoScroll(page, settings.scroll);
		if (idle > 0) yield* step("network-idle", () => page.waitForLoadState("networkidle", { timeout: idle })).pipe(Effect.ignore);
	}
	yield* Effect.sleep(settings.settle);
	yield* step("fonts", () => page.evaluate(() => document.fonts.ready.then(() => void 0)));
	const target = page.locator(settings.selector).first();
	yield* step("select", () => target.waitFor({
		state: "attached",
		timeout: Duration.toMillis(settings.waitForTimeout)
	}));
	const stamp = `${yield* Clock.currentTimeMillis}`;
	yield* step("select", () => target.evaluate((element, [name, value]) => element.setAttribute(name, value), [markAttribute, stamp]));
	const rect = yield* step("measure", () => target.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return {
			width: Math.ceil(bounds.width),
			height: Math.ceil(bounds.height)
		};
	})).pipe(Effect.flatMap(decodeAt("measure", Rect)));
	yield* Effect.logInfo(`Capturing ${settings.selector} (${rect.width}×${rect.height})`);
	if (settings.pinImageHeights) yield* pinImageHeights(page);
	const expression = `(${serializer.source})('[${markAttribute}="${stamp}"]')`;
	const result = yield* step("serialize", () => page.evaluate(expression)).pipe(Effect.timeout(settings.captureTimeout), Effect.mapError((error) => Schema.is(CaptureError)(error) ? error : new CaptureError({
		stage: "serialize",
		message: "Timed out"
	})), Effect.flatMap(decodeAt("serialize", CaptureResult)), Effect.ensuring(settings.pinImageHeights ? unpinImageHeights(page) : Effect.void));
	if (result.status === "aborted") return yield* new CaptureError({
		stage: "serialize",
		message: "Aborted"
	});
	if (result.status === "error") return yield* new CaptureError({
		stage: "serialize",
		message: result.error
	});
	const pageUrl = page.url();
	const images = settings.inlineImages === "always" || settings.inlineImages === "auto" && isPrivateHost(pageUrl) ? yield* inlineImages(result.html, session.context, pageUrl, settings.imageTimeout) : {
		html: result.html,
		count: 0
	};
	const title = yield* step("title", () => page.title());
	return {
		html: images.html,
		width: rect.width,
		height: rect.height,
		title: title === "" ? URL.parse(pageUrl)?.host ?? pageUrl : title,
		url: pageUrl,
		inlinedImages: images.count
	};
});
//#endregion
//#region src/clipboard.ts
/** Puts a snapshot on the macOS pasteboard exactly as the extension does, for a manual ⌘V. */
var ClipboardError = class extends Schema.TaggedError()("Clipboard.ClipboardError", { message: Schema.String }) {};
/** JXA: read the file at argv[0] and publish it as HTML on the general pasteboard. */
const script = `
ObjC.import("AppKit");
function run(argv) {
  const html = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  pasteboard.setStringForType(html, "public.html");
}`;
const write = Effect.fn("Clipboard.write")(function* (html) {
	if (process.platform !== "darwin") return yield* new ClipboardError({ message: "--clipboard is only supported on macOS" });
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const file = yield* fs.makeTempFileScoped({ suffix: ".html" });
	yield* fs.writeFileString(file, `<x-paper-html>${html}</x-paper-html>`);
	const exitCode = yield* spawner.exitCode(ChildProcess.make("osascript", [
		"-l",
		"JavaScript",
		"-e",
		script,
		file
	]));
	if (exitCode !== 0) return yield* new ClipboardError({ message: `osascript exited with ${exitCode}` });
}, Effect.scoped, Effect.mapError((error) => Schema.is(ClipboardError)(error) ? error : new ClipboardError({ message: error.message })));
//#endregion
//#region src/extension.ts
/**
* Obtains the Paper Snapshot serializer from the official Chrome extension.
*
* The extension is downloaded from the Chrome Web Store on first use and cached; its
* capture function is located by behaviour, not by its minified name, so new extension
* releases keep working. No Paper code ships with paper-snap.
*/
/** Paper Snapshot on the Chrome Web Store. */
const paperSnapshotId = "lidfahaahiogmnlccifabccgplofocck";
/** Strings only the extension's DOM serializer contains. */
const serializerMarkers = ["x-paper-style-reference", "paper-snapshot-original-tag"];
var ExtensionError = class extends Schema.TaggedError()("Extension.ExtensionError", { message: Schema.String }) {};
var Service$1 = class extends Context.Service()("paper-snap/extension/Service") {};
const Manifest = Schema.Struct({ version: Schema.String });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const textDecoder = new TextDecoder();
/** CRX3: "Cr24", format version, header length, header, then a plain zip archive. */
const zipPayload = (bytes) => {
	if (!(bytes[0] === 67 && bytes[1] === 114 && bytes[2] === 50 && bytes[3] === 52)) return bytes;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerEnd = view.getUint32(4, true) === 2 ? 16 + view.getUint32(8, true) + view.getUint32(12, true) : 12 + view.getUint32(8, true);
	return bytes.subarray(headerEnd);
};
/** A stand-in for the `chrome` extension API: every property access and call yields another. */
const inertChromeApi = () => new Proxy(() => {}, {
	get: () => inertChromeApi(),
	apply: () => inertChromeApi()
});
/**
* Runs extension scripts in an isolated VM context and returns the source of the function
* that contains every serializer marker. Script top-level code only registers listeners on
* the inert `chrome` stand-in, so evaluating it has no effect.
*/
const findSerializer = (scripts) => {
	for (const script of scripts) {
		if (!serializerMarkers.every((marker) => script.includes(marker))) continue;
		const sandbox = vm.createContext({ chrome: inertChromeApi() });
		sandbox["self"] = sandbox;
		vm.runInContext(script, sandbox, { timeout: 2e3 });
		for (const name of Object.keys(sandbox)) {
			if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
			const source = String(vm.runInContext(`typeof ${name} === "function" ? Function.prototype.toString.call(${name}) : ""`, sandbox));
			if (serializerMarkers.every((marker) => source.includes(marker))) return Option.some(source);
		}
	}
	return Option.none();
};
const layer$1 = Layer.effect(Service$1, Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const http = yield* HttpClient.HttpClient;
	const fail = (message) => new ExtensionError({ message });
	const unpackArchive = Effect.fn("Extension.unpackArchive")(function* (bytes) {
		const files = yield* Effect.try({
			try: () => unzipSync(zipPayload(bytes)),
			catch: () => fail("The extension archive is not a valid CRX or zip file")
		});
		const manifest = files["manifest.json"];
		if (manifest === void 0) return yield* fail("The extension archive has no manifest.json");
		const { version } = yield* decodeManifest(textDecoder.decode(manifest)).pipe(Effect.mapError(() => fail("The extension manifest has no version")));
		return {
			version,
			scripts: Object.entries(files).flatMap(([name, content]) => name.endsWith(".js") ? [{
				name,
				text: textDecoder.decode(content)
			}] : [])
		};
	});
	const readDirectory = Effect.fn("Extension.readDirectory")(function* (directory) {
		const manifest = yield* fs.readFileString(path.join(directory, "manifest.json")).pipe(Effect.mapError(() => fail(`${directory} has no manifest.json`)));
		const { version } = yield* decodeManifest(manifest).pipe(Effect.mapError(() => fail("The extension manifest has no version")));
		const names = yield* fs.readDirectory(directory, { recursive: true }).pipe(Effect.mapError((error) => fail(`Could not read ${directory}: ${error.message}`)));
		return {
			version,
			scripts: yield* Effect.forEach(names.filter((name) => name.endsWith(".js")), (name) => fs.readFileString(path.join(directory, name)).pipe(Effect.map((text) => ({
				name,
				text
			})), Effect.mapError((error) => fail(`Could not read ${name}: ${error.message}`))))
		};
	});
	const readLocal = Effect.fn("Extension.readLocal")(function* (location) {
		if ((yield* fs.stat(location).pipe(Effect.mapError(() => fail(`${location} does not exist`)))).type === "Directory") return yield* readDirectory(location);
		if (location.endsWith(".js")) {
			const text = yield* fs.readFileString(location).pipe(Effect.mapError((error) => fail(`Could not read ${location}: ${error.message}`)));
			return {
				version: "local",
				scripts: [{
					name: path.basename(location),
					text
				}]
			};
		}
		const bytes = yield* fs.readFile(location).pipe(Effect.mapError((error) => fail(`Could not read ${location}: ${error.message}`)));
		return yield* unpackArchive(bytes);
	});
	const download = Effect.fn("Extension.download")(function* (extensionId) {
		const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc`;
		yield* Effect.logInfo(`Downloading the Paper Snapshot extension (${extensionId})`);
		const buffer = yield* http.get(url).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.flatMap((response) => response.arrayBuffer), Effect.timeout("60 seconds"), Effect.mapError((error) => fail(`Downloading the extension failed: ${error.message}`)));
		return new Uint8Array(buffer);
	});
	const extract = (unpacked, origin) => Effect.try({
		try: () => findSerializer(unpacked.scripts.map((script) => script.text)),
		catch: (error) => fail(`Evaluating the extension failed: ${String(error)}`)
	}).pipe(Effect.flatMap(Option.match({
		onNone: () => Effect.fail(fail(`Extension ${unpacked.version} has no recognisable serializer; Paper may have changed it`)),
		onSome: (source) => Effect.succeed({
			source,
			version: unpacked.version,
			origin
		})
	})));
	const serializer = Effect.fn("Extension.serializer")(function* (settings) {
		if (Option.isSome(settings.localPath)) return yield* extract(yield* readLocal(settings.localPath.value), settings.localPath.value);
		const cached = path.join(settings.cacheDir, `${settings.extensionId}.crx`);
		if ((yield* fs.exists(cached).pipe(Effect.orElseSucceed(() => false))) && !settings.refresh) {
			const fromCache = yield* readLocal(cached).pipe(Effect.flatMap((unpacked) => extract(unpacked, cached)), Effect.option);
			if (Option.isSome(fromCache)) return fromCache.value;
		}
		const bytes = yield* download(settings.extensionId);
		const unpacked = yield* unpackArchive(bytes);
		const result = yield* extract(unpacked, `chrome web store (${settings.extensionId})`);
		yield* fs.makeDirectory(settings.cacheDir, { recursive: true }).pipe(Effect.andThen(fs.writeFile(cached, bytes)), Effect.catch((error) => Effect.logWarning(`Could not cache the extension: ${error.message}`)));
		return result;
	});
	return Service$1.of({ serializer });
}));
//#endregion
//#region src/paper.ts
/** Writes snapshots into Paper through the MCP relay that ships with the Paper app. */
var PaperError = class extends Schema.TaggedError()("Paper.PaperError", {
	tool: Schema.String,
	message: Schema.String
}) {};
var Service = class extends Context.Service()("paper-snap/paper/Service") {};
const TextBlock = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String
});
const ToolResult = Schema.Struct({
	content: Schema.Array(Schema.Union([TextBlock, Schema.Struct({ type: Schema.String })])),
	isError: Schema.optional(Schema.Boolean)
});
/** Paper prefixes every tool result with a file header block. */
const FileHeader = Schema.fromJsonString(Schema.Struct({ file: Schema.Struct({ id: Schema.String }) }));
const CreatedNode = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const layer = Layer.succeed(Service, Service.of({ connect: Effect.fn("Paper.connect")(function* (settings) {
	const client = new Client({
		name: "paper-snap",
		version: "0.1.0"
	});
	yield* Effect.acquireRelease(Effect.tryPromise({
		try: () => client.connect(new StdioClientTransport({
			command: settings.bin,
			args: ["mcp"]
		})),
		catch: (error) => new PaperError({
			tool: "connect",
			message: `Could not start ${settings.bin} mcp (is the Paper app installed and open?): ${error instanceof Error ? error.message : String(error)}`
		})
	}), () => Effect.promise(() => client.close()).pipe(Effect.ignore));
	const call = Effect.fn("Paper.call")(function* (tool, args) {
		const raw = yield* Effect.tryPromise({
			try: () => client.callTool({
				name: tool,
				arguments: { ...args }
			}, void 0, { timeout: Duration.toMillis(settings.timeout) }),
			catch: (error) => new PaperError({
				tool,
				message: error instanceof Error ? error.message : String(error)
			})
		});
		const result = yield* Schema.decodeUnknownEffect(ToolResult)(raw).pipe(Effect.mapError((error) => new PaperError({
			tool,
			message: `Unexpected response: ${error.message}`
		})));
		const texts = result.content.flatMap((block) => Schema.is(TextBlock)(block) ? [block.text] : []);
		if (result.isError === true) return yield* new PaperError({
			tool,
			message: texts.join("\n")
		});
		return texts;
	});
	const lastBlock = (tool, texts, schema) => Schema.decodeEffect(schema)(texts.at(-1) ?? "").pipe(Effect.mapError((error) => new PaperError({
		tool,
		message: `Unexpected response: ${error.message}`
	})));
	const activeFileId = call("get_basic_info", {}).pipe(Effect.flatMap((texts) => Schema.decodeEffect(FileHeader)(texts[0] ?? "").pipe(Effect.mapError(() => new PaperError({
		tool: "get_basic_info",
		message: "No Paper file is open; open one or pass --file-id"
	})))), Effect.map((header) => header.file.id));
	return { place: Effect.fn("Paper.place")(function* (placement, html, keepOnFailure) {
		const fileId = Option.isSome(placement.fileId) ? placement.fileId.value : yield* activeFileId;
		const created = yield* call("create_artboard", {
			fileId,
			name: placement.name,
			...Option.match(placement.pageId, {
				onNone: () => ({}),
				onSome: (pageId) => ({ pageId })
			}),
			styles: {
				width: `${placement.width}px`,
				height: `${Math.max(placement.height, 1)}px`
			}
		});
		const { id: artboardId } = yield* lastBlock("create_artboard", created, CreatedNode);
		yield* Effect.logInfo(`Writing ${Math.round(html.length / 1024)} KB into "${placement.name}"`);
		yield* call("write_html", {
			fileId,
			targetNodeId: artboardId,
			mode: "insert-children",
			html
		}).pipe(Effect.tapError(() => keepOnFailure ? Effect.void : call("delete_nodes", {
			fileId,
			nodeIds: [artboardId]
		}).pipe(Effect.ignore)));
		if (Option.isSome(placement.x) || Option.isSome(placement.y)) {
			const position = {
				...Option.match(placement.x, {
					onNone: () => ({}),
					onSome: (x) => ({ left: `${x}px` })
				}),
				...Option.match(placement.y, {
					onNone: () => ({}),
					onSome: (y) => ({ top: `${y}px` })
				})
			};
			yield* call("update_styles", {
				fileId,
				updates: [{
					nodeIds: [artboardId],
					styles: position
				}]
			});
		}
		yield* call("finish_working_on_nodes", { fileId }).pipe(Effect.ignore);
		return {
			fileId,
			artboardId
		};
	}) };
}) }));
//#endregion
//#region src/cli.ts
/** `paper-snap`: every behaviour is a flag; defaults suit a one-shot capture into the open Paper file. */
const milliseconds = (name, fallback, description) => Flag.integer(name).pipe(Flag.withDescription(`${description} (ms)`), Flag.withDefault(fallback));
const optionalString = (name, description) => Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);
const optionalInteger = (name, description) => Flag.integer(name).pipe(Flag.withDescription(description), Flag.optional);
const repeatable = (name, description) => Flag.string(name).pipe(Flag.withDescription(`${description} (repeatable)`), Flag.atLeast(0));
const flags = {
	url: Argument.string("url").pipe(Argument.withDescription("Page to load. Omit it to capture the attached browser's current tab"), Argument.optional),
	source: Flag.choice("source", [
		"auto",
		"launch",
		"cdp",
		"agent-browser",
		"playwriter"
	]).pipe(Flag.withDescription("Where the page lives. auto: launch a browser when <url> is given, otherwise attach to agent-browser. playwriter: your own Chrome via the Playwriter extension"), Flag.withDefault("auto")),
	cdp: optionalString("cdp", "CDP endpoint to attach to (http://host:port or ws://…); implies --source cdp"),
	playwriterEndpoint: Flag.string("playwriter-endpoint").pipe(Flag.withDescription("Playwriter relay CDP endpoint"), Flag.withDefault("http://127.0.0.1:19988")),
	tab: optionalString("tab", "Attached browsers: capture the tab whose URL or title contains this text (default: the visible tab)"),
	agentBrowserBin: Flag.string("agent-browser-bin").pipe(Flag.withDescription("agent-browser executable"), Flag.withDefault("agent-browser")),
	agentBrowserSession: optionalString("agent-browser-session", "agent-browser session name"),
	browser: Flag.string("browser").pipe(Flag.withDescription("Chromium-based executable to launch (default: installed Chrome/Edge/Brave/Chromium)"), Flag.withFallbackConfig(Config.string("PAPER_SNAP_BROWSER")), Flag.optional),
	browserArgs: repeatable("browser-arg", "Extra command-line argument for the launched browser"),
	headed: Flag.boolean("headed").pipe(Flag.withDescription("Show the launched browser"), Flag.withDefault(false)),
	downloadBrowser: Flag.boolean("download-browser").pipe(Flag.withDescription("Download headless Chromium when no installed browser is found"), Flag.withDefault(true)),
	connectTimeout: milliseconds("connect-timeout", 3e4, "Browser launch/attach timeout"),
	width: optionalInteger("width", "Viewport width in px (default 1440; attached tabs keep theirs)"),
	height: optionalInteger("height", "Viewport height in px (default 900; attached tabs keep theirs)"),
	scale: Flag.float("scale").pipe(Flag.withDescription("Device scale factor"), Flag.withDefault(1)),
	colorScheme: Flag.choice("color-scheme", [
		"light",
		"dark",
		"no-preference"
	]).pipe(Flag.withDescription("Emulated prefers-color-scheme"), Flag.optional),
	userAgent: optionalString("user-agent", "User agent override"),
	locale: optionalString("locale", "Locale, e.g. fr-FR"),
	timezone: optionalString("timezone", "Time zone, e.g. Africa/Douala"),
	headers: Flag.keyValuePair("header").pipe(Flag.withDescription("Extra request header as name=value (repeatable)"), Flag.withDefault({})),
	storageState: optionalString("storage-state", "Playwright storage-state JSON with cookies/localStorage"),
	selector: Flag.string("selector").pipe(Flag.withAlias("s"), Flag.withDescription("CSS selector of the element to capture"), Flag.withDefault("body")),
	waitUntil: Flag.choice("wait-until", [
		"load",
		"domcontentloaded",
		"networkidle",
		"commit"
	]).pipe(Flag.withDescription("Navigation milestone to wait for"), Flag.withDefault("load")),
	navigationTimeout: milliseconds("navigation-timeout", 6e4, "Navigation timeout"),
	networkIdleTimeout: milliseconds("network-idle-timeout", 15e3, "Max wait for network idle; 0 skips it"),
	waitFor: optionalString("wait-for", "Selector that must appear before capturing"),
	waitForTimeout: milliseconds("wait-for-timeout", 3e4, "Timeout for --wait-for and --selector"),
	evals: repeatable("eval", "JavaScript to run in the page before capturing"),
	evalFiles: repeatable("eval-file", "File of JavaScript to run in the page before capturing"),
	scroll: Flag.boolean("scroll").pipe(Flag.withDescription("Scroll through the page first so lazy content loads"), Flag.withDefault(true)),
	scrollStep: optionalInteger("scroll-step", "Scroll step in px (default 80% of the viewport)"),
	scrollDelay: milliseconds("scroll-delay", 120, "Pause between scroll steps"),
	scrollMax: Flag.integer("scroll-max").pipe(Flag.withDescription("Stop auto-scrolling after this many px"), Flag.withDefault(5e4)),
	settle: milliseconds("settle", 500, "Pause before capturing"),
	pinImageHeights: Flag.boolean("pin-image-heights").pipe(Flag.withDescription("Freeze rendered image heights so Paper keeps aspect ratios"), Flag.withDefault(true)),
	inlineImages: Flag.choice("inline-images", [
		"auto",
		"always",
		"never"
	]).pipe(Flag.withDescription("Embed images as data URIs. auto: only for localhost/private hosts Paper can't reach"), Flag.withDefault("auto")),
	imageTimeout: milliseconds("image-timeout", 15e3, "Per-image download timeout when inlining"),
	captureTimeout: milliseconds("capture-timeout", 12e4, "Serializer timeout"),
	extension: optionalString("extension", "Paper Snapshot extension to use: .crx, .zip, unpacked directory, or .js"),
	extensionId: Flag.string("extension-id").pipe(Flag.withDescription("Chrome Web Store id of Paper Snapshot"), Flag.withDefault(paperSnapshotId)),
	refreshExtension: Flag.boolean("refresh-extension").pipe(Flag.withDescription("Re-download the extension instead of using the cached copy"), Flag.withDefault(false)),
	cacheDir: optionalString("cache-dir", "Cache directory (default ~/.cache/paper-snap)"),
	push: Flag.boolean("push").pipe(Flag.withDescription("Create an artboard in Paper (default unless --out or --clipboard is given)"), Flag.optional),
	clipboard: Flag.boolean("clipboard").pipe(Flag.withDescription("Copy the snapshot for a manual ⌘V into Paper (macOS)"), Flag.withDefault(false)),
	out: optionalString("out", "Write the snapshot HTML to a file, or \"-\" for stdout").pipe(Flag.withAlias("o")),
	json: Flag.boolean("json").pipe(Flag.withDescription("Print a JSON result summary on stdout"), Flag.withDefault(false)),
	fileId: optionalString("file-id", "Paper file id (default: the file open in Paper)"),
	pageId: optionalString("page-id", "Paper page id (default: the active page)"),
	name: optionalString("name", "Artboard name (default: page title · host)"),
	x: optionalInteger("x", "Artboard x position on the canvas"),
	y: optionalInteger("y", "Artboard y position on the canvas"),
	paperBin: optionalString("paper-bin", "Paper CLI that provides the MCP relay (default ~/.paper/bin/paper)"),
	paperTimeout: milliseconds("paper-timeout", 3e5, "Timeout per Paper tool call"),
	keepOnFailure: Flag.boolean("keep-on-failure").pipe(Flag.withDescription("Keep the artboard when writing into it fails"), Flag.withDefault(false))
};
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
	clipboard: Schema.Boolean
});
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Summary));
const resolveSource = (input) => Effect.gen(function* () {
	const source = Option.isSome(input.cdp) && input.source === "auto" ? "cdp" : input.source;
	const launch = Source.Launch({
		executablePath: input.browser,
		headed: input.headed,
		args: input.browserArgs,
		download: input.downloadBrowser
	});
	const agentBrowser = Source.AgentBrowser({
		bin: input.agentBrowserBin,
		session: input.agentBrowserSession
	});
	if (source === "launch") return launch;
	if (source === "agent-browser") return agentBrowser;
	if (source === "playwriter") return Source.Playwriter({ endpoint: input.playwriterEndpoint });
	if (source === "cdp") {
		if (Option.isNone(input.cdp)) return yield* new BrowserError({ message: "--source cdp needs --cdp <endpoint>" });
		return Source.Attach({ endpoint: input.cdp.value });
	}
	return Option.isSome(input.url) ? launch : agentBrowser;
});
const handler = Effect.fn("paper-snap")(function* (input) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* Config.string("HOME").pipe(Config.withDefault("."));
	const xdgCache = yield* Config.option(Config.string("XDG_CACHE_HOME"));
	const push = Option.getOrElse(input.push, () => Option.isNone(input.out) && !input.clipboard);
	const scripts = [...input.evals, ...yield* Effect.forEach(input.evalFiles, (file) => fs.readFileString(file))];
	const cacheDir = Option.getOrElse(input.cacheDir, () => path.join(Option.getOrElse(xdgCache, () => path.join(home, ".cache")), "paper-snap"));
	const serializer = yield* (yield* Service$1).serializer({
		extensionId: input.extensionId,
		localPath: input.extension,
		cacheDir,
		refresh: input.refreshExtension
	});
	yield* Effect.logDebug(`Paper Snapshot ${serializer.version} from ${serializer.origin}`);
	const source = yield* resolveSource(input);
	const browser = yield* Service$2;
	const viewport = Option.isNone(input.width) && Option.isNone(input.height) ? Option.none() : Option.some({
		width: Option.getOrElse(input.width, () => 1440),
		height: Option.getOrElse(input.height, () => 900)
	});
	const snapshot = yield* Effect.scoped(Effect.gen(function* () {
		const session = yield* browser.open(source, {
			viewport,
			scale: input.scale,
			colorScheme: input.colorScheme,
			userAgent: input.userAgent,
			locale: input.locale,
			timezone: input.timezone,
			headers: input.headers,
			storageState: input.storageState,
			connectTimeout: Duration.millis(input.connectTimeout),
			tab: input.tab
		}, Option.isSome(input.url));
		yield* Effect.logInfo(`Browser: ${session.origin}`);
		return {
			...yield* capture(session, input.url, serializer, {
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
					maxDistance: input.scrollMax
				},
				settle: Duration.millis(input.settle),
				pinImageHeights: input.pinImageHeights,
				inlineImages: input.inlineImages,
				imageTimeout: Duration.millis(input.imageTimeout),
				captureTimeout: Duration.millis(input.captureTimeout)
			}),
			browser: session.origin
		};
	}));
	yield* Effect.logInfo(`Captured ${Math.round(snapshot.html.length / 1024)} KB of HTML`);
	if (Option.isSome(input.out)) {
		if (input.out.value === "-") yield* Console.log(snapshot.html);
		else yield* fs.writeFileString(input.out.value, snapshot.html);
	}
	if (input.clipboard) {
		yield* write(snapshot.html);
		yield* Effect.logInfo("Copied to the clipboard; paste into Paper with ⌘V");
	}
	const artboard = push ? Option.some(yield* Effect.scoped(Effect.gen(function* () {
		return yield* (yield* (yield* Service).connect({
			bin: Option.getOrElse(input.paperBin, () => path.join(home, ".paper", "bin", "paper")),
			timeout: Duration.millis(input.paperTimeout)
		})).place({
			fileId: input.fileId,
			pageId: input.pageId,
			name: Option.getOrElse(input.name, () => `${snapshot.title} · ${URL.parse(snapshot.url)?.host ?? snapshot.url}`),
			width: snapshot.width,
			height: snapshot.height,
			x: input.x,
			y: input.y
		}, snapshot.html, input.keepOnFailure);
	}))) : Option.none();
	yield* Effect.forEach(Option.toArray(artboard), (placed) => Effect.logInfo(`Created artboard ${placed.artboardId} in file ${placed.fileId}`));
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
			clipboard: input.clipboard
		});
		yield* Console.log(summary);
	}
});
const command = Command.make("paper-snap", flags, handler).pipe(Command.withDescription("Snapshot a URL, local dev server, or an already-open browser tab into Paper as editable layers, using the Paper Snapshot extension's serializer."), Command.withExamples([
	{
		command: "paper-snap https://linear.app",
		description: "Whole page into the open Paper file"
	},
	{
		command: "paper-snap http://localhost:3000 -s \"#pricing\" --width 390 --height 844",
		description: "One element of a local dev server, mobile viewport"
	},
	{
		command: "paper-snap",
		description: "Capture the tab agent-browser is showing"
	},
	{
		command: "paper-snap --source playwriter --tab localhost:3000",
		description: "Capture a tab of your own Chrome through the Playwriter extension"
	},
	{
		command: "paper-snap --cdp http://localhost:9222",
		description: "Capture the active tab of any CDP browser"
	},
	{
		command: "paper-snap https://example.com --out snap.html --json",
		description: "HTML only, JSON summary"
	}
]));
//#endregion
//#region src/bin.ts
const LoggerLive = Logger.layer([Logger.consolePretty({ stderr: true })]);
const MainLive = Layer.mergeAll(layer$2, layer$1.pipe(Layer.provide(FetchHttpClient.layer)), layer).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(LoggerLive));
Command.run(command, { version: "0.1.0" }).pipe(Effect.tapError((error) => Console.error(`paper-snap: ${error.message}`)), Effect.provide(MainLive), NodeRuntime.runMain({
	disableErrorReporting: true,
	teardown: (exit, onExit) => Runtime.defaultTeardown(exit, (code) => {
		onExit(code);
		process.exit(code);
	})
}));
//#endregion
export {};
