/** Renders rows as a left-aligned text table with a header row. */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: readonly string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
