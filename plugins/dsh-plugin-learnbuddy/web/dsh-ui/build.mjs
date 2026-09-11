import { readFile, mkdir, writeFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("client.cjs", import.meta.url), "utf8");
const speech = ts.transpileModule(await readFile(new URL("../src/speech.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const combined = `const { createDictation } = (() => { const exports = {}; ${speech}; return exports; })();\n${source}`;
new Script(combined, { filename: "learnbuddy-dsh-ui.cjs" });
const output = `window.__ModuleLoader__.load({id: "@learnbuddy/dsh-ui", factory: (require) => {
const module = { exports: {} };
const exports = module.exports;
${combined}
return module.exports;
}});\n`;
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/client.js", import.meta.url), output);
console.log(`LearnBuddy DSH UI: ${Buffer.byteLength(output)} bytes`);
