import { describe, expect, it } from "vitest";
import { defineMigration, mapBlocks, omit, renameBlock, renameProp, type Block } from "./helpers.ts";

describe("mapBlocks", () => {
  it("moves a top-level block's images into its first category and drops images (worked example)", () => {
    const document = {
      body: [
        {
          type: "serviced-apartments",
          props: {
            images: ["a.jpg", "b.jpg"],
            categories: [{ name: "Studio" }, { name: "Suite" }],
          },
        },
      ],
    };
    const migrated = mapBlocks(document, "serviced-apartments", (block) => {
      const props = block.props ?? {};
      const images = props.images;
      const categories = (props.categories as Array<Record<string, unknown>> | undefined) ?? [];
      if (!Array.isArray(images) || categories.length === 0) return block;
      const [first, ...rest] = categories;
      return { ...block, props: omit({ ...props, categories: [{ ...first, images }, ...rest] }, "images") };
    });

    const block = (migrated.body as Block[])[0]!;
    expect(block.props?.images).toBeUndefined();
    expect(block.props?.categories).toEqual([{ name: "Studio", images: ["a.jpg", "b.jpg"] }, { name: "Suite" }]);
  });

  it("reaches a block nested inside slots.left of a columns block", () => {
    const document = {
      body: [
        {
          type: "columns",
          slots: {
            left: [{ type: "hero", props: { title: "old" } }],
            right: [{ type: "text", props: { html: "keep" } }],
          },
        },
      ],
    };
    const migrated = mapBlocks(document, "hero", (block) => ({ ...block, props: { ...block.props, title: "new" } }));
    const columns = (migrated.body as Block[])[0]!;
    expect(columns.slots?.left?.[0]?.props?.title).toBe("new");
    expect(columns.slots?.right?.[0]?.props?.html).toBe("keep");
  });

  it("removes a node when fn returns null", () => {
    const document = { body: [{ type: "ad" }, { type: "text", props: { html: "keep" } }] };
    const migrated = mapBlocks(document, "ad", () => null);
    expect(migrated.body).toEqual([{ type: "text", props: { html: "keep" } }]);
  });

  it("returns the document unchanged when blocksField is not an array", () => {
    const document = { body: "not-an-array", other: 1 };
    expect(mapBlocks(document, "hero", (b) => b)).toBe(document);
  });

  it("uses a custom blocksField", () => {
    const document = { content: [{ type: "hero", props: {} }] };
    const migrated = mapBlocks(document, "hero", (b) => ({ ...b, type: "hero2" }), "content");
    expect((migrated.content as Block[])[0]?.type).toBe("hero2");
  });

  it("removes a node nested inside slots when fn returns null", () => {
    const document = {
      body: [{ type: "columns", slots: { left: [{ type: "ad" }, { type: "text", props: { html: "keep" } }] } }],
    };
    const migrated = mapBlocks(document, "ad", () => null);
    const columns = (migrated.body as Block[])[0]!;
    expect(columns.slots?.left).toEqual([{ type: "text", props: { html: "keep" } }]);
  });

  it("visits a child before its parent when both share the same type", () => {
    const visited: string[] = [];
    const document = {
      body: [{ type: "columns", slots: { left: [{ type: "columns", props: { id: "child" } }] }, props: { id: "parent" } }],
    };
    mapBlocks(document, "columns", (block) => {
      visited.push(block.props?.id as string);
      return block;
    });
    expect(visited).toEqual(["child", "parent"]);
  });

  it("keeps a non-array slot value as it is", () => {
    const document: Record<string, unknown> = { body: [{ type: "hero", slots: { left: "not-an-array" } }] };
    const migrated = mapBlocks(document, "hero", (b) => ({ ...b, props: { ...b.props, title: "new" } }));
    expect((migrated.body as Block[])[0]?.slots?.left).toBe("not-an-array");
  });

  it("does not mutate the input document, its blocks, or nested slot arrays", () => {
    const document = {
      body: [{ type: "columns", slots: { left: [{ type: "hero", props: { title: "old" } }] } }],
    };
    const before = structuredClone(document);
    mapBlocks(document, "hero", (block) => ({ ...block, props: { title: "new" } }));
    expect(document).toEqual(before);
  });
});

describe("renameBlock", () => {
  it("renames every block of the given type, at any depth", () => {
    const document = {
      body: [
        { type: "serviced-apartments", props: {} },
        { type: "columns", slots: { left: [{ type: "serviced-apartments", props: {} }] } },
      ],
    };
    const migrated = renameBlock(document, "serviced-apartments", "apartments");
    const blocks = migrated.body as Block[];
    expect(blocks[0]?.type).toBe("apartments");
    expect(blocks[1]?.slots?.left?.[0]?.type).toBe("apartments");
  });
});

describe("renameProp", () => {
  it("moves a prop from one key to another", () => {
    const block: Block = { type: "hero", props: { headline: "Hi" } };
    expect(renameProp(block, "headline", "title")).toEqual({ type: "hero", props: { title: "Hi" } });
  });

  it("leaves the block unchanged when the source prop is absent", () => {
    const block: Block = { type: "hero", props: { title: "Hi" } };
    expect(renameProp(block, "headline", "title")).toBe(block);
  });

  it("leaves the block unchanged when it has no props at all", () => {
    const block: Block = { type: "hero" };
    expect(renameProp(block, "headline", "title")).toBe(block);
  });
});

describe("omit", () => {
  it("drops a single key given as a string", () => {
    expect(omit({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });

  it("drops every key given as an array", () => {
    expect(omit({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ b: 2 });
  });

  it("does not mutate the input object", () => {
    const obj = { a: 1, b: 2 };
    const before = structuredClone(obj);
    omit(obj, "a");
    expect(obj).toEqual(before);
  });
});

describe("defineMigration", () => {
  it("returns the migration unchanged", () => {
    const migration = { id: "m1", collection: "pages", up: () => null };
    expect(defineMigration(migration)).toBe(migration);
  });
});
