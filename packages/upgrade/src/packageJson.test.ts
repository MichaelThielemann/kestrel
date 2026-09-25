import { describe, expect, it } from "vitest";
import { applyEdits } from "./apply.ts";
import { removeDependency, replaceDependency, setDependencyRange } from "./packageJson.ts";

const FILE = "package.json";

describe("setDependencyRange", () => {
  it("adds a brand-new dependency at the block's own indentation, not the key line's", () => {
    const source = '{\n  "name": "app",\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^6.0.0"\n  }\n}\n';
    const edit = setDependencyRange(FILE, source, "dependencies", "@michaelthielemann/kestrel-events-direct", "^6.0.0");
    const { text } = applyEdits(source, [edit]);
    expect(text).toContain('\n    "@michaelthielemann/kestrel-events-direct": "^6.0.0"');
    expect(JSON.parse(text)).toEqual({
      name: "app",
      dependencies: { "@michaelthielemann/kestrel": "^6.0.0", "@michaelthielemann/kestrel-events-direct": "^6.0.0" },
    });
  });

  it("matches a deeper indentation unit than 2 spaces just as well", () => {
    const source = '{\n    "name": "app",\n    "dependencies": {\n        "@michaelthielemann/kestrel": "^6.0.0"\n    }\n}\n';
    const edit = setDependencyRange(FILE, source, "dependencies", "@michaelthielemann/kestrel-events-direct", "^6.0.0");
    const { text } = applyEdits(source, [edit]);
    expect(text).toContain('\n        "@michaelthielemann/kestrel-events-direct": "^6.0.0"');
  });

  it("creates the dependencies block itself at the root object's own child indentation", () => {
    const source = '{\n  "name": "app"\n}\n';
    const edit = setDependencyRange(FILE, source, "dependencies", "@michaelthielemann/kestrel", "^6.0.0");
    const { text } = applyEdits(source, [edit]);
    expect(JSON.parse(text)).toEqual({ name: "app", dependencies: { "@michaelthielemann/kestrel": "^6.0.0" } });
    expect(text).toContain('\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^6.0.0"\n  }\n}');
  });

  it("fills an existing but empty dependencies block one level deeper than its own line", () => {
    const source = '{\n  "name": "app",\n  "dependencies": {\n  }\n}\n';
    const edit = setDependencyRange(FILE, source, "dependencies", "@michaelthielemann/kestrel", "^6.0.0");
    const { text } = applyEdits(source, [edit]);
    expect(JSON.parse(text)).toEqual({ name: "app", dependencies: { "@michaelthielemann/kestrel": "^6.0.0" } });
    expect(text).toContain('\n    "@michaelthielemann/kestrel": "^6.0.0"\n  }');
  });

  it("keeps an existing entry's own indentation when only updating its range", () => {
    const source = '{\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^5.8.0"\n  }\n}\n';
    const edit = setDependencyRange(FILE, source, "dependencies", "@michaelthielemann/kestrel", "^6.0.0");
    const { text } = applyEdits(source, [edit]);
    expect(text).toBe('{\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^6.0.0"\n  }\n}\n');
  });
});

describe("replaceDependency", () => {
  it("swaps a dependency in place without disturbing the block's own indentation", () => {
    const source = '{\n  "dependencies": {\n    "@michaelthielemann/kestrel-events-direct": "^6.0.0",\n    "@michaelthielemann/kestrel": "^6.0.0"\n  }\n}\n';
    const edits = replaceDependency(FILE, source, "dependencies", "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-queue", "^6.0.0");
    const { text } = applyEdits(source, edits);
    expect(JSON.parse(text)).toEqual({ dependencies: { "@michaelthielemann/kestrel-events-queue": "^6.0.0", "@michaelthielemann/kestrel": "^6.0.0" } });
    expect(text).toContain('\n    "@michaelthielemann/kestrel-events-queue": "^6.0.0",');
  });
});

describe("removeDependency", () => {
  it("removes an entry and its own trailing comma, keeping the rest untouched", () => {
    const source = '{\n  "dependencies": {\n    "@michaelthielemann/kestrel-events-direct": "^6.0.0",\n    "@michaelthielemann/kestrel": "^6.0.0"\n  }\n}\n';
    const edit = removeDependency(FILE, source, "dependencies", "@michaelthielemann/kestrel-events-direct");
    const { text } = applyEdits(source, edit ? [edit] : []);
    expect(JSON.parse(text)).toEqual({ dependencies: { "@michaelthielemann/kestrel": "^6.0.0" } });
  });
});
