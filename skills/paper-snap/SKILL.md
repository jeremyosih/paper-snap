---
name: paper-snap
description: Snapshot web UI into Paper as editable layers. Use when a URL, local dev server, component, or live browser state should land in a Paper file.
---

# paper-snap

`paper-snap` serializes a page or element with Paper Snapshot's own serializer and writes it as a new artboard into the file open in the Paper app. Every behaviour is a flag; `paper-snap --help` is the reference.

## Steps

1. **Pick the source.**
   - A URL, public or localhost, with no interaction needed: `paper-snap <url>`. It launches the installed Chrome headlessly.
   - A state that takes interaction to reach (logged in, modal open, form filled): get the browser there first, then capture its tab without a URL.
     - agent-browser: `paper-snap` (it captures the tab agent-browser is on).
     - The user's everyday Chrome, also what Chrome DevTools MCP drives with `--autoConnect`: `paper-snap --source chrome --tab <text in the tab's URL or title>`. This needs remote debugging enabled at `chrome://inspect/#remote-debugging`, and the user clicks Allow when Chrome asks.
     - Playwriter: `--source playwriter --tab <text>`. Any other CDP browser: `--cdp <endpoint>`.

   Done when you know which command you will run.

2. **Scope it.** `-s <css>` captures one element (a card, a nav, a dialog); the default is the whole page. Match the device with `--width`/`--height`, and dark mode with `--color-scheme dark`.

3. **Run with `--json`.** Stdout carries one JSON line (`artboardId`, `fileId`, `width`, `height`, `url`); logs go to stderr. A failure exits non-zero with one `paper-snap: <reason>` line.

4. **Verify.** Screenshot the artboard with the Paper MCP `get_screenshot`, using `fileId` and `artboardId` from the JSON. Done when the artboard shows the intended state, with images and sections intact.

## Gotchas

- The Paper app must be running: the push goes through its MCP relay at `~/.paper/bin/paper`. `--file-id` and `--page-id` target a specific file and page.
- Snapshots run to several MB. Let paper-snap carry the HTML; reach for `--out snap.html` when a file on disk is the goal.
- Images on localhost and private hosts are inlined automatically because Paper cannot reach them. Use `--inline-images always` for assets behind auth.
- Sections that animate in on scroll can come out blank: give them time with `--settle 2000`, or force the final state with `--eval`.
- Auth: attach to a browser that is already logged in (`--source chrome` is the user's own session), or pass `--storage-state <file>` to a launched one.
- Attached browsers stay open. Passing a URL while attached opens a temporary tab and closes it afterwards.
- The first run downloads the Paper Snapshot extension from the Chrome Web Store and caches it in `~/.cache/paper-snap`.
