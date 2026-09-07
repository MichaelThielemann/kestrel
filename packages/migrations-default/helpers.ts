import type { Migration } from "@michaelthielemann/kestrel-contracts/migrations";

export interface Block {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  slots?: Record<string, Block[]>;
}

export function defineMigration(m: Migration): Migration {
  return m;
}

function walkNode(node: Block, type: string, fn: (block: Block) => Block | null): Block | null {
  let next = node;
  if (node.slots) {
    const slots: Record<string, Block[]> = {};
    for (const [key, children] of Object.entries(node.slots)) {
      slots[key] = Array.isArray(children)
        ? children.flatMap((child) => {
            const mapped = walkNode(child, type, fn);
            return mapped === null ? [] : [mapped];
          })
        : children;
    }
    next = { ...node, slots };
  }
  return next.type === type ? fn(next) : next;
}

export function mapBlocks(document: Record<string, unknown>, type: string, fn: (block: Block) => Block | null, blocksField = "body"): Record<string, unknown> {
  const blocks = document[blocksField];
  if (!Array.isArray(blocks)) return document;
  const mapped = (blocks as Block[]).flatMap((node) => {
    const result = walkNode(node, type, fn);
    return result === null ? [] : [result];
  });
  return { ...document, [blocksField]: mapped };
}

export function renameBlock(document: Record<string, unknown>, from: string, to: string, blocksField = "body"): Record<string, unknown> {
  return mapBlocks(document, from, (b) => ({ ...b, type: to }), blocksField);
}

export function renameProp(block: Block, from: string, to: string): Block {
  if (!block.props || !(from in block.props)) return block;
  const { [from]: value, ...rest } = block.props;
  return { ...block, props: { ...rest, [to]: value } };
}

export function omit<T extends Record<string, unknown>>(obj: T, keys: string | string[]): Partial<T> {
  const drop = new Set(Array.isArray(keys) ? keys : [keys]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) if (!drop.has(key)) out[key] = value;
  return out as Partial<T>;
}
