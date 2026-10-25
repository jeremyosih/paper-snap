---
name: paper-snapshot
description: Snapshot web UI into Paper as editable layers. Use when a URL, local dev server, set of app screens, or live browser state should land in a Paper file, or when Paper artboards need refreshing from the app.
---

# paper-snapshot

`paper-snapshot` serializes pages with Paper Snapshot's own serializer and writes each as an artboard into the file open in the Paper app. Every behaviour is a flag; `paper-snapshot --help` is the reference.

## Steps

1. **Pick the source.**
   - URLs, public or localhost: `paper-snapshot <url> [<url or /path>…]`. It launches the installed Chrome headlessly.
   - A state that takes interaction to reach and that page-state flags (step 2) cannot set up: get a browser there, then capture its tab without a URL.
     - agent-browser: `paper-snapshot` (captures the tab agent-browser is on).
     - The user's everyday Chrome, also what Chrome DevTools MCP drives with `--autoConnect`: `paper-snapshot --source chrome --tab <text in the tab's URL or title>`. This needs remote debugging enabled at `chrome://inspect/#remote-debugging`; the user clicks Allow when Chrome asks.
     - Playwriter: `--source playwriter --tab <text>`. Any other CDP browser: `--cdp <endpoint>`.

2. **Set up the state.** Sign-in: `--storage-state auth.json`, or `--cookie "name=value"`. Theme and flags that apps keep in storage: `--local-storage key=value` (`--color-scheme dark` alone only flips the media query). Menus and dialogs: `--click <selector>`, repeatable, in order. `--eval` covers anything else.

3. **Scope it.** `-s <css>` captures one element; the default is the whole page. Internal scroll containers (`h-screen` shells) are unclipped automatically. Match the device with `--width`/`--height`.

4. **Place it.** One screen: optional `--name`, `--page-id`, `--x/--y`, `--below <artboardId>` or `--right-of <artboardId>`. Several screens: pass several URLs, or a `--manifest` JSON file whose items set per-screen fields (`name`, `colorScheme`, `localStorage`, `x`, `below`, `replace`, …). They share one browser and one Paper connection and are arranged by `--layout row|column|grid`. Refreshing a screen after the app changed: `--replace <artboardId>`, which keeps the artboard's id, position and name.

5. **Run with `--json`.** Stdout carries one JSON line per artboard: `artboardId`, `fileId`, `x`, `y`, `width`, `height`, and `warnings`. A failed capture prints `{"index", "url", "error"}`, the batch continues, and the exit code is 1.

6. **Verify.** Read each line's `warnings`; any non-zero count names what imported badly (`emptySvgs`, `unresolvedSprites`, `clippedScrollContainers`, `unresolvedImages`, `lostColspans`). Screenshot flagged artboards with the Paper MCP `get_screenshot`. Done when every artboard shows the intended state with zero warnings, or the remaining ones are explained.

## Gotchas

- The Paper app must be running: the push goes through its MCP relay at `~/.paper/bin/paper`. `--file-id` and `--page-id` target a specific file and page.
- Snapshots run to several MB. Let paper-snapshot carry the HTML; `--out` writes it to disk (a directory for several captures).
- Images on localhost and private hosts are inlined automatically because Paper cannot reach them. Use `--inline-images always` for assets behind auth.
- Sections that animate in on scroll can come out blank: give them time with `--settle 2000`, or force the final state with `--eval`.
- Attached browsers stay open. Passing a URL while attached opens a temporary tab and closes it afterwards.
- `--quiet` keeps stderr to warnings and errors across long batches.
