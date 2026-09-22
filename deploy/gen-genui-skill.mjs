// Regenerate the generative-ui-builder SKILL.md section from the REAL catalog
// (catalog.prompt()), so the AI-facing docs can never drift from the code.
//
// Run from web/:  node --experimental-strip-types ../deploy/gen-genui-skill.mjs
// (node >=24 strips TS types natively; deps resolve from web/node_modules)
import { genuiCatalog } from "../web/src/lib/genui-catalog.ts";

const SKILL = new URL("./catalog/skills/generative-ui-builder/SKILL.md", import.meta.url);
const START = "<!-- genui-catalog-prompt:start -->";
const END = "<!-- genui-catalog-prompt:end -->";

const prompt = genuiCatalog.prompt();
// Keep only the drift-prone part: the generated component list (props +
// descriptions). The full protocol prompt (state/repeat/pushState) is
// overkill for our curated chat surface and would steer small models into
// state-bound specs our transport doesn't use.
const k = prompt.indexOf("AVAILABLE COMPONENTS (");
if (k < 0) { console.error("component list not found in catalog.prompt()"); process.exit(1); }
const tail = prompt.slice(k);
const lines = tail.split("\n");
let end = lines.length;
for (let n = 0; n < lines.length; n++) {
  if (n > 1 && lines[n].trim() && !lines[n].startsWith("- ")) { end = n; break; }
}
const listPart = lines.slice(0, end).join("\n").trim();
import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync(SKILL, "utf8");
const i = text.indexOf(START);
const j = text.indexOf(END);
if (i < 0 || j < 0) {
  console.error("markers not found in SKILL.md — add them first");
  process.exit(1);
}
const out = text.slice(0, i + START.length) + "\n\n" + listPart + "\n\n" + text.slice(j);
writeFileSync(SKILL, out);
console.log("regenerated component list:", listPart.length, "chars");
