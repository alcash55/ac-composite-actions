import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { parse } from "yaml";

// The house standard (see markdown-checks/spellcheck/index.test.js): every
// output action.yml declares must actually be set by the implementation, or
// it silently stays empty forever.
describe("action.yml <-> index.js output contract", () => {
  it("sets every output name that action.yml references via steps.*.outputs.*", () => {
    const doc = parse(readFileSync(new URL("./action.yml", import.meta.url), "utf-8"));
    const declaredNames = Object.values(doc.outputs ?? {}).map((output) => {
      const match = String(output.value).match(/steps\.[\w-]+\.outputs\.([A-Za-z0-9_]+)/);

      if (!match) {
        throw new Error(`Could not parse an output reference from: ${output.value}`);
      }

      return match[1];
    });

    expect(declaredNames).not.toHaveLength(0);

    const source = readFileSync(new URL("./index.js", import.meta.url), "utf-8");
    const setNames = new Set(
      [...source.matchAll(/core\.setOutput\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]),
    );

    for (const name of declaredNames) {
      expect(setNames, `index.js never calls core.setOutput("${name}", ...)`).toContain(name);
    }
  });
});
