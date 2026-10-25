# paper-snapshot

Paper Snapshot as a CLI. Copy and paste your real site directly into Paper as editable layers. No more screenshots.

Give paper-snapshot a URL, a local dev server, or a tab an agent already clicked its way to. It
loads the page, captures it (or a single element) with [Paper Snapshot](https://paper.design/snapshot-extension)'s
own serializer, and writes the result into the Paper file you have open as a new artboard: real
text, real layout, real colors and images, every layer editable. It is the Paper Snapshot
extension without the clicking, so an agent can bring a whole app into Paper in one command and
refresh any screen when the app changes.

## Install

paper-snapshot needs Node 22 or later, the [Paper](https://paper.design/downloads) app running
(for pushing into a file), and a Chromium-based browser. An installed Chrome, Edge, Brave or
Chromium is found automatically; with none, a headless Chromium is downloaded once.

```sh
npm install -g https://github.com/jeremyosih/paper-snapshot/tarball/main
```

The first run downloads the Paper Snapshot extension from the Chrome Web Store and caches it in
`~/.cache/paper-snapshot`. Nothing from Paper ships in this repository.

## Agents

Install the agent skill for Claude Code, OpenCode, Codex and other agents:

```sh
npx skills add jeremyosih/paper-snapshot --skill paper-snapshot -g
```

With the skill, an agent picks the source (a URL, or the browser it drove), sets up state such as
sign-in, theme and open menus with flags instead of scripts, places the artboards, and runs with
`--json`. Each capture prints one line with the artboard id, position, size and `warnings`, a count
of anything that won't import cleanly, so the agent can screenshot the artboards that need a look
and report the rest. The skill also tells the agent which steps wait on you, such as Chrome's
**Allow** dialog, so you hear about them before the command blocks.

## Usage

```sh
# A whole page, into the Paper file you have open
paper-snapshot https://linear.app

# One element of a local dev server, at phone size
paper-snapshot http://localhost:3000 -s "#pricing" --width 390 --height 844

# Several screens side by side (paths resolve against the first URL)
paper-snapshot http://localhost:3000/ /pricing /settings --layout row

# A batch from a manifest, one JSON line per artboard
paper-snapshot --manifest screens.json --json

# Refresh an existing artboard after the app changed (same id, position and name)
paper-snapshot http://localhost:3000/settings --replace 1A-0

# App state without scripting: dark theme kept in storage, a session cookie, an open menu
paper-snapshot http://localhost:3000 --local-storage theme=dark --color-scheme dark \
  --cookie "session=…" --click "[data-testid=account-menu]"

# The tab agent-browser is on, after it logged in and opened a dialog
paper-snapshot

# A tab in your everyday Chrome (click Allow when Chrome asks)
paper-snapshot --source chrome --tab localhost:3000

# Just the HTML, or the extension's exact clipboard payload for a manual ⌘V
paper-snapshot https://example.com --out snap.html
paper-snapshot https://example.com --clipboard
```

Every behaviour is a flag with a default: viewport, color scheme, page state, timeouts, scrolling,
fidelity passes, and the target file, page and position in Paper. `paper-snapshot --help` lists
them all.

## Browsers

Pages come from one of five places, chosen with `--source`:

| Source          | Page comes from                                                                                             | What you do                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `launch`        | A headless copy of your installed Chrome. The default when a URL is given                                   | Nothing                                                                             |
| `agent-browser` | The tab [agent-browser](https://github.com/vercel-labs/agent-browser) is driving. The default without a URL | Keep an agent-browser session open                                                  |
| `chrome`        | Your everyday Chrome, with your logins. Tried after agent-browser when no URL is given                      | Turn on `chrome://inspect/#remote-debugging` once, then click **Allow** on each run |
| `playwriter`    | Your Chrome through the [Playwriter](https://github.com/remorses/playwriter) extension                      | Connect the extension to its relay                                                  |
| `cdp`           | Any Chrome DevTools Protocol endpoint (`--cdp`)                                                             | Start that browser with remote debugging                                            |

Attaching lets an agent click, type and sign in first, then capture exactly that state. Attached
browsers are never closed. Passing a URL while attached opens a temporary tab and closes it after;
without a URL, `--tab <text>` picks the tab whose URL or title contains the text, and otherwise
the visible one.

With `--source chrome`, Chrome shows **Allow remote debugging?** each time paper-snapshot connects,
on the machine Chrome runs on, and keeps a "controlled by automated test software" banner up while
it's attached. The command waits for you, up to `--chrome-approval-timeout` (2 minutes); **Cancel**
fails it. A batch connects once, so it asks once. paper-snapshot reads Chrome's port from its
`DevToolsActivePort` file; when macOS hides that file from the calling app, it connects to
`127.0.0.1:9222` instead (`--chrome-port`).

## Batches and placement

Several URLs, or a `--manifest` JSON file, run as one batch over one browser and one Paper
connection. Each capture prints its own JSON line, and a failed capture prints
`{"index", "url", "error"}` without stopping the rest; the exit code is 1 if any failed.

A manifest item is a URL, or an object whose fields mirror the flags in camelCase.
`{ "defaults": {…}, "items": […] }` shares fields:

```json
{
  "defaults": { "width": 1440, "storageState": "member.json" },
  "items": [
    { "url": "/", "name": "Home · light" },
    {
      "url": "/",
      "name": "Home · dark",
      "colorScheme": "dark",
      "localStorage": { "theme": "dark" }
    },
    { "url": "/settings", "replace": "1A-0" }
  ]
}
```

New artboards follow `--layout row|column|grid` (with `--columns` and `--gap`) from the first
one, which `--x/--y`, `--below <artboardId>` or `--right-of <artboardId>` anchor. Without an
anchor, Paper picks an empty spot. `--replace <artboardId>` re-captures into an existing artboard
and keeps its id, position and name; `--file-id` and `--page-id` choose where new ones go.

## Fidelity

Before serializing, paper-snapshot adjusts the page so it imports the way it renders, and undoes
every change afterwards:

| Problem                                                                      | What paper-snapshot does                                           | Flag                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| App shells (`h-screen` with an `overflow: auto` main) cut off below the fold | Grows the viewport until no scroll container clips                 | `--full-page`         |
| Icons from external SVG sprites import empty                                 | Fetches the sprite and inlines the symbol with its computed colors | `--inline-sprites`    |
| A `colspan` cell imports one column wide                                     | Freezes the table into rows and cells at their rendered widths     | `--fix-colspans`      |
| `height: auto` images collapse                                               | Pins rendered image heights                                        | `--pin-image-heights` |
| Paper can't fetch images from localhost                                      | Inlines them as data URIs                                          | `--inline-images`     |

Each pass is on by default; `--no-<flag>` turns one off. Whatever still won't import cleanly is
counted in the `warnings` of each JSON line: `emptySvgs`, `unresolvedSprites`,
`clippedScrollContainers`, `unresolvedImages` and `lostColspans`.

`--color-scheme` only flips the `prefers-color-scheme` media query. Apps that keep their theme in
storage also need `--local-storage <key>=dark`.

## How it works

The Paper Snapshot extension walks the element you pick, keeps only the computed styles that
differ from the browser's defaults, folds in pseudo-elements, canvas and video frames, form state
and same-document SVG references, and copies the resulting HTML to the clipboard wrapped in
`<x-paper-html>`. Paper turns that paste into layers.

paper-snapshot downloads the extension from the Chrome Web Store, evaluates its scripts in a
sandbox, and finds that serializer by what it does, not by its minified name, so new releases of
the extension keep working. It runs the serializer in the page through the Chrome DevTools
Protocol, then writes the HTML into a new artboard through the MCP relay that ships with the Paper
app (`~/.paper/bin/paper mcp`). `--clipboard` writes the extension's exact clipboard payload
instead.

## Development

```sh
bun install && bun run setup   # dependencies, Effect diagnostics for TypeScript, git hooks
bun run check                  # oxfmt and oxlint with anti-slop (vite-plus), tsc with Effect diagnostics, knip
bun run build                  # dist/bin.mjs, committed so installs from GitHub need no build
bun run dev -- https://example.com --out -
```

Built with [Effect](https://effect.website) 4 and its CLI module. Paper and Paper Snapshot are
products of Paper; this project is not affiliated with them.

## License

MIT
