/** Writes snapshots into Paper through the MCP relay that ships with the Paper app. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export interface Settings {
  readonly bin: string;
  readonly timeout: Duration.Duration;
}

/** Where a new artboard goes; `Auto` lets Paper pick an empty spot. */
export type Position = Data.TaggedEnum<{
  Auto: {};
  At: { readonly x: Option.Option<number>; readonly y: Option.Option<number> };
  Below: { readonly artboardId: string; readonly gap: number };
  RightOf: { readonly artboardId: string; readonly gap: number };
}>;

export const Position = Data.taggedEnum<Position>();

export type Target = Data.TaggedEnum<{
  Create: {
    readonly fileId: Option.Option<string>;
    readonly pageId: Option.Option<string>;
    readonly name: string;
    readonly position: Position;
  };
  /** Re-snapshot into an existing artboard, keeping its id, position, and (by default) name. */
  Replace: {
    readonly fileId: Option.Option<string>;
    readonly artboardId: string;
    readonly name: Option.Option<string>;
  };
}>;

export const Target = Data.taggedEnum<Target>();

interface Artboard {
  readonly fileId: string;
  readonly artboardId: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly replaced: boolean;
}

class PaperError extends Schema.TaggedError<PaperError, { readonly brand: unique symbol }>()(
  "Paper.PaperError",
  {
    tool: Schema.String,
    message: Schema.String,
  },
) {}

interface Connection {
  /**
   * Writes a snapshot of the given size into a new or existing artboard. A new artboard is
   * removed again if writing into it fails, unless `keepOnFailure`.
   */
  readonly place: (
    target: Target,
    size: { readonly width: number; readonly height: number },
    html: string,
    keepOnFailure: boolean,
  ) => Effect.Effect<Artboard, PaperError>;
}

export interface Interface {
  readonly connect: (settings: Settings) => Effect.Effect<Connection, PaperError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()(
  "paper-snapshot-cli/paper/Service",
) {}

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Union([TextBlock, Schema.Struct({ type: Schema.String })])),
  isError: Schema.optional(Schema.Boolean),
});

/** Paper prefixes every tool result with a file header block. */
const FileHeader = Schema.fromJsonString(
  Schema.Struct({ file: Schema.Struct({ id: Schema.String }) }),
);

/** Paper prefixes every tool result, errors included, with this header block. */
const isFileHeader = (text: string) => Option.isSome(Schema.decodeOption(FileHeader)(text));

const CreatedNode = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, worldX: Schema.Finite, worldY: Schema.Finite }),
);

const NodeInfo = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    width: Schema.NullOr(Schema.Finite),
    height: Schema.NullOr(Schema.Finite),
    worldX: Schema.NullOr(Schema.Finite),
    worldY: Schema.NullOr(Schema.Finite),
    parentId: Schema.NullOr(Schema.String),
    childIds: Schema.Array(Schema.String),
  }),
);

/** JSON arguments accepted by Paper's MCP tools. */
type ToolArgument =
  | string
  | number
  | boolean
  | ReadonlyArray<ToolArgument>
  | { readonly [key: string]: ToolArgument };

export const layer = Layer.succeed(
  Service,
  Service.of({
    connect: Effect.fn("Paper.connect")(function* (settings: Settings) {
      const client = new Client({ name: "paper-snapshot", version: "0.1.5" });
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            client.connect(new StdioClientTransport({ command: settings.bin, args: ["mcp"] })),
          catch: (error) =>
            new PaperError({
              tool: "connect",
              message: `Could not start ${settings.bin} mcp (is the Paper app installed and open?): ${error instanceof Error ? error.message : String(error)}`,
            }),
        }),
        () => Effect.promise(() => client.close()).pipe(Effect.ignore),
      );

      const call = Effect.fn("Paper.call")(function* (
        tool: string,
        args: { readonly [key: string]: ToolArgument },
      ) {
        const raw = yield* Effect.tryPromise({
          try: () =>
            client.callTool({ name: tool, arguments: { ...args } }, undefined, {
              timeout: Duration.toMillis(settings.timeout),
            }),
          catch: (error) =>
            new PaperError({
              tool,
              message: error instanceof Error ? error.message : String(error),
            }),
        });

        const result = yield* Schema.decodeUnknownEffect(ToolResult)(raw).pipe(
          Effect.mapError(
            (error) => new PaperError({ tool, message: `Unexpected response: ${error.message}` }),
          ),
        );

        const texts = result.content.flatMap((block) =>
          Schema.is(TextBlock)(block) ? [block.text] : [],
        );

        if (result.isError === true) {
          // Drop the file header block; the rest is Paper's own explanation.
          const reason = texts.filter((text) => !isFileHeader(text)).join("\n");

          return yield* new PaperError({ tool, message: reason.trim() });
        }

        return texts;
      });

      const lastBlock = <A>(
        tool: string,
        texts: ReadonlyArray<string>,
        schema: Schema.Codec<A, string>,
      ) =>
        Schema.decodeEffect(schema)(texts.at(-1) ?? "").pipe(
          Effect.mapError(
            (error) => new PaperError({ tool, message: `Unexpected response: ${error.message}` }),
          ),
        );

      const activeFileId = call("get_basic_info", {}).pipe(
        Effect.flatMap((texts) =>
          Schema.decodeEffect(FileHeader)(texts[0] ?? "").pipe(
            Effect.mapError(
              () =>
                new PaperError({
                  tool: "get_basic_info",
                  message: "No Paper file is open; open one or pass --file-id",
                }),
            ),
          ),
        ),
        Effect.map((header) => header.file.id),
      );

      const fileOf = (fileId: Option.Option<string>) =>
        Option.isSome(fileId) ? Effect.succeed(fileId.value) : activeFileId;

      const nodeInfo = (fileId: string, nodeId: string) =>
        call("get_node_info", { fileId, nodeId }).pipe(
          Effect.flatMap((texts) => lastBlock("get_node_info", texts, NodeInfo)),
          Effect.mapError(
            () =>
              new PaperError({
                tool: "get_node_info",
                message: `Artboard ${nodeId} not found in file ${fileId}; check the id, or pass --file-id for another file`,
              }),
          ),
        );

      /** Geometry and page of an artboard that a relative position refers to. */
      const reference = Effect.fn("Paper.reference")(function* (
        fileId: string,
        artboardId: string,
      ) {
        const node = yield* nodeInfo(fileId, artboardId);
        const { worldX, worldY, width, height } = node;

        if (worldX === null || worldY === null || width === null || height === null) {
          return yield* new PaperError({
            tool: "get_node_info",
            message: `Artboard ${artboardId} has no measured geometry (is its page open in Paper?)`,
          });
        }

        const pageId = Option.fromNullishOr(node.parentId?.match(/^root_node_(.+)$/)?.[1]);

        return { pageId, x: worldX, y: worldY, width, height };
      });

      /** Resolves a position to a page and canvas coordinates. */
      const anchor = (fileId: string, position: Position) =>
        Position.$match(position, {
          Auto: () =>
            Effect.succeed({
              pageId: Option.none<string>(),
              x: Option.none<number>(),
              y: Option.none<number>(),
            }),
          At: ({ x, y }) => Effect.succeed({ pageId: Option.none<string>(), x, y }),
          Below: ({ artboardId, gap }) =>
            reference(fileId, artboardId).pipe(
              Effect.map((ref) => ({
                pageId: ref.pageId,
                x: Option.some(ref.x),
                y: Option.some(ref.y + ref.height + gap),
              })),
            ),
          RightOf: ({ artboardId, gap }) =>
            reference(fileId, artboardId).pipe(
              Effect.map((ref) => ({
                pageId: ref.pageId,
                x: Option.some(ref.x + ref.width + gap),
                y: Option.some(ref.y),
              })),
            ),
        });

      const write = (fileId: string, artboardId: string, name: string, html: string) =>
        Effect.logInfo(`Writing ${Math.round(html.length / 1024)} KB into "${name}"`).pipe(
          Effect.andThen(
            call("write_html", { fileId, targetNodeId: artboardId, mode: "insert-children", html }),
          ),
        );

      const create = Effect.fn("Paper.create")(function* (
        target: Extract<Target, { readonly _tag: "Create" }>,
        size: { readonly width: number; readonly height: number },
        html: string,
        keepOnFailure: boolean,
      ) {
        const fileId = yield* fileOf(target.fileId);
        const spot = yield* anchor(fileId, target.position);
        const pageId = Option.orElse(target.pageId, () => spot.pageId);
        const height = Math.max(size.height, 1);

        const created = yield* call("create_artboard", {
          fileId,
          name: target.name,
          ...Option.match(pageId, { onNone: () => ({}), onSome: (page) => ({ pageId: page }) }),
          styles: { width: `${size.width}px`, height: `${height}px` },
        }).pipe(Effect.flatMap((texts) => lastBlock("create_artboard", texts, CreatedNode)));

        yield* write(fileId, created.id, target.name, html).pipe(
          Effect.tapError(() =>
            keepOnFailure
              ? Effect.void
              : call("delete_nodes", { fileId, nodeIds: [created.id] }).pipe(Effect.ignore),
          ),
        );

        const x = Option.getOrElse(spot.x, () => created.worldX);
        const y = Option.getOrElse(spot.y, () => created.worldY);

        if (Option.isSome(spot.x) || Option.isSome(spot.y)) {
          yield* call("update_styles", {
            fileId,
            updates: [{ nodeIds: [created.id], styles: { left: `${x}px`, top: `${y}px` } }],
          });
        }

        return {
          fileId,
          artboardId: created.id,
          name: target.name,
          x,
          y,
          width: size.width,
          height,
          replaced: false,
        } satisfies Artboard;
      });

      const replace = Effect.fn("Paper.replace")(function* (
        target: Extract<Target, { readonly _tag: "Replace" }>,
        size: { readonly width: number; readonly height: number },
        html: string,
      ) {
        const fileId = yield* fileOf(target.fileId);
        const existing = yield* nodeInfo(fileId, target.artboardId);
        const name = Option.getOrElse(target.name, () => existing.name);
        const height = Math.max(size.height, 1);

        if (existing.childIds.length > 0) {
          yield* call("delete_nodes", { fileId, nodeIds: existing.childIds });
        }

        yield* call("update_styles", {
          fileId,
          updates: [
            {
              nodeIds: [existing.id],
              styles: { width: `${size.width}px`, height: `${height}px` },
            },
          ],
        });

        if (name !== existing.name) {
          yield* call("rename_nodes", { fileId, updates: [{ nodeId: existing.id, name }] });
        }

        yield* write(fileId, existing.id, name, html);

        return {
          fileId,
          artboardId: existing.id,
          name,
          x: existing.worldX ?? 0,
          y: existing.worldY ?? 0,
          width: size.width,
          height,
          replaced: true,
        } satisfies Artboard;
      });

      const place = Effect.fn("Paper.place")(function* (
        target: Target,
        size: { readonly width: number; readonly height: number },
        html: string,
        keepOnFailure: boolean,
      ) {
        const artboard = yield* Target.$match(target, {
          Create: (create_) => create(create_, size, html, keepOnFailure),
          Replace: (replace_) => replace(replace_, size, html),
        });

        yield* call("finish_working_on_nodes", { fileId: artboard.fileId }).pipe(Effect.ignore);

        return artboard;
      });

      return { place } satisfies Connection;
    }),
  }),
);
