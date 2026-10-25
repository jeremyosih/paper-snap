# paper-snap

Snapshot any URL, local dev server, or live browser tab into [Paper](https://paper.design) as editable layers, from the command line. It does what the [Paper Snapshot](https://paper.design/snapshot-extension) extension does, but headlessly, so coding agents can do it too.

```sh
paper-snap https://linear.app                                    # whole page → new artboard
paper-snap http://localhost:3000 -s "#pricing" --width 390       # one element, mobile width
paper-snap http://localhost:3000/ /pricing /settings             # several screens in a row
paper-snap --manifest screens.json --json                        # a batch, one JSON line each
paper-snap http://localhost:3000/settings --replace 1A-0         # refresh an existing artboard
paper-snap http://localhost:3000 --local-storage theme=dark      # app state without scripting
paper-snap                                                       # the tab agent-browser is on
paper-snap --source chrome --tab localhost:3000                  # a tab in your everyday Chrome
```

## Install

```sh
npm install -g https://github.com/jeremyosih/paper-snap/tarball/main
npx skills add jeremyosih/paper-snap --skill paper-snap -g   # the agent skill
```

Requirements: Node 22+, the Paper app running (for pushing), and a Chromium-based browser. Installed Chrome, Edge, Brave and Chromium are found automatically; if none is installed, a headless Chromium is downloaded once.

## How it works

1. **Serializer.** On first run, paper-snap downloads the Paper Snapshot extension from the Chrome Web Store and caches it in `~/.cache/paper-snap`. It evaluates the extension's scripts in a sandbox and extracts the function that turns a DOM element into Paper's snapshot HTML (computed styles inlined, pseudo-elements, SVG, canvas and video frames, form state). The function is found by behaviour, not by name, so extension updates keep working. Nothing from Paper is bundled here.
2. **Page.** The page is loaded, given its state (cookies, storage, clicks), and scrolled so lazy content renders. Before serializing, a few passes make it import cleanly, and are undone afterwards:
   - the viewport grows until no internal scroll container clips content (`h-screen` app shells);
   - external SVG sprites (`<use href="/sprite.svg#icon">`) are inlined with their computed colors;
   - tables with `colspan` cells are frozen into flex rows at their rendered widths;
   - image heights are pinned, since Paper's importer does not infer aspect ratios;
   - images on private hosts are inlined as data URIs, since Paper cannot fetch them.

   Anything that still won't import well is counted in the `warnings` of the `--json` output.

3. **Paper.** The HTML goes into a new artboard through the MCP relay that ships with the Paper app (`~/.paper/bin/paper mcp`). `--clipboard` instead writes the exact payload the extension writes, for a manual ⌘V.

## Browser sources

| `--source`      | Page comes from                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `chrome`        | Your everyday Chrome once `chrome://inspect/#remote-debugging` is on (Chrome 144+); Chrome asks you to Allow            |
| `launch`        | A headless installed Chrome (default when a URL is given)                                                               |
| `agent-browser` | The tab [agent-browser](https://github.com/vercel-labs/agent-browser) is driving (default without a URL, then `chrome`) |
| `playwriter`    | Your own Chrome via the [Playwriter](https://github.com/remorses/playwriter) extension                                  |
| `cdp`           | Any Chrome DevTools Protocol endpoint (`--cdp`)                                                                         |

Attaching lets an agent click, type and log in first, then capture exactly that state. Attached browsers are left running.

## Batches and placement

Several URLs, or a `--manifest` JSON file, run as one batch: one browser, one Paper connection, one JSON line per artboard, and failures reported per capture without stopping the rest. Manifest items are a URL string or an object whose fields mirror the flags in camelCase; `{ "defaults": {…}, "items": […] }` sets shared fields.

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

Artboards are laid out with `--layout row|column|grid` (`--columns`, `--gap`) from the first one's position. `--x/--y`, `--below <id>` or `--right-of <id>` anchor that first artboard. `--replace <id>` refreshes an existing artboard in place, keeping its id, position and name.

Every behaviour is a flag: viewport, color scheme, page state, headers, timeouts, scrolling, fidelity passes, the target file, page and position in Paper. See `paper-snap --help`.

## Development

```sh
bun install && bun run setup
bun run check     # oxfmt + oxlint/anti-slop (vite-plus), tsc with Effect diagnostics, knip
bun run build     # dist/bin.mjs (committed, so git installs need no build)
bun run dev -- https://example.com --out -
```

Built with [Effect](https://effect.website) v4 and its CLI module. Paper Snapshot and Paper are products of Paper; this project is unaffiliated.

## License

MIT
