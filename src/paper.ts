/** Writes snapshots into Paper through the MCP relay that ships with the Paper app. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Context from "effect/Context";
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

export interface Placement {
  readonly fileId: Option.Option<string>;
  readonly pageId: Option.Option<string>;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly x: Option.Option<number>;
  readonly y: Option.Option<number>;
}

interface Artboard {
  readonly fileId: string;
  readonly artboardId: string;
}

class PaperError extends Schema.TaggedError<PaperError>()("Paper.PaperError", {
  tool: Schema.String,
  message: Schema.String,
}) {}

interface Connection {
  /** Creates an artboard and fills it with the snapshot; removes the artboard if writing fails. */
  readonly place: (
    placement: Placement,
    html: string,
    keepOnFailure: boolean,
  ) => Effect.Effect<Artboard, PaperError>;
}

export interface Interface {
  readonly connect: (settings: Settings) => Effect.Effect<Connection, PaperError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("paper-snap/paper/Service") {}

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Union([TextBlock, Schema.Struct({ type: Schema.String })])),
  isError: Schema.optional(Schema.Boolean),
});

/** Paper prefixes every tool result with a file header block. */
const FileHeader = Schema.fromJsonString(
  Schema.Struct({ file: Schema.Struct({ id: Schema.String }) }),
);

const CreatedNode = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));

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
      const client = new Client({ name: "paper-snap", version: "0.2.0" });
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

        if (result.isError === true)
          return yield* new PaperError({ tool, message: texts.join("\n") });

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

      const place = Effect.fn("Paper.place")(function* (
        placement: Placement,
        html: string,
        keepOnFailure: boolean,
      ) {
        const fileId = Option.isSome(placement.fileId)
          ? placement.fileId.value
          : yield* activeFileId;

        const created = yield* call("create_artboard", {
          fileId,
          name: placement.name,
          ...Option.match(placement.pageId, {
            onNone: () => ({}),
            onSome: (pageId) => ({ pageId }),
          }),
          styles: { width: `${placement.width}px`, height: `${Math.max(placement.height, 1)}px` },
        });

        const { id: artboardId } = yield* lastBlock("create_artboard", created, CreatedNode);

        yield* Effect.logInfo(
          `Writing ${Math.round(html.length / 1024)} KB into "${placement.name}"`,
        );
        yield* call("write_html", {
          fileId,
          targetNodeId: artboardId,
          mode: "insert-children",
          html,
        }).pipe(
          Effect.tapError(() =>
            keepOnFailure
              ? Effect.void
              : call("delete_nodes", { fileId, nodeIds: [artboardId] }).pipe(Effect.ignore),
          ),
        );

        if (Option.isSome(placement.x) || Option.isSome(placement.y)) {
          const position = {
            ...Option.match(placement.x, {
              onNone: () => ({}),
              onSome: (x) => ({ left: `${x}px` }),
            }),
            ...Option.match(placement.y, {
              onNone: () => ({}),
              onSome: (y) => ({ top: `${y}px` }),
            }),
          };

          yield* call("update_styles", {
            fileId,
            updates: [{ nodeIds: [artboardId], styles: position }],
          });
        }

        yield* call("finish_working_on_nodes", { fileId }).pipe(Effect.ignore);

        return { fileId, artboardId };
      });

      return { place } satisfies Connection;
    }),
  }),
);
