function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

type Op = { kind: "equal" | "delete" | "insert"; line: string };

function opsOf(a: readonly string[], b: readonly string[]): Op[] {
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", line: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "delete", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "insert", line: b[j]! });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "delete", line: a[i]! });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "insert", line: b[j]! });
    j++;
  }
  return ops;
}

function hunkRanges(ops: readonly Op[], context: number): Array<[number, number]> {
  const changeIndexes: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== "equal") changeIndexes.push(i);
  });
  if (changeIndexes.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changeIndexes[0]! - context);
  let end = Math.min(ops.length, changeIndexes[0]! + 1 + context);
  for (let k = 1; k < changeIndexes.length; k++) {
    const idx = changeIndexes[k]!;
    const nextStart = Math.max(0, idx - context);
    if (nextStart <= end) {
      end = Math.min(ops.length, idx + 1 + context);
    } else {
      ranges.push([start, end]);
      start = nextStart;
      end = Math.min(ops.length, idx + 1 + context);
    }
  }
  ranges.push([start, end]);
  return ranges;
}

/** A unified diff of `before` -> `after`, 3 lines of context, in the classic `--- a/<file>` / `+++ b/<file>` form; `""` when the two are equal. */
export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const ops = opsOf(splitLines(before), splitLines(after));
  const ranges = hunkRanges(ops, context);

  const aLineAt: number[] = [1];
  const bLineAt: number[] = [1];
  for (const op of ops) {
    aLineAt.push(aLineAt.at(-1)! + (op.kind === "insert" ? 0 : 1));
    bLineAt.push(bLineAt.at(-1)! + (op.kind === "delete" ? 0 : 1));
  }

  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const [start, end] of ranges) {
    const group = ops.slice(start, end);
    const aCount = group.filter((o) => o.kind !== "insert").length;
    const bCount = group.filter((o) => o.kind !== "delete").length;
    lines.push(`@@ -${aLineAt[start]},${aCount} +${bLineAt[start]},${bCount} @@`);
    for (const op of group) {
      if (op.kind === "equal") lines.push(` ${op.line}`);
      else if (op.kind === "delete") lines.push(`-${op.line}`);
      else lines.push(`+${op.line}`);
    }
  }
  return lines.join("\n");
}
