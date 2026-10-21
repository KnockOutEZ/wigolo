import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rewriteLinks,
  contentPathFor,
  takeTitle,
  parseIndexTable,
  firstParagraph,
  mapOutsideFences,
  flatten,
} from "./sync-content.mjs";

const known = {
  docs: new Set(["tools.md", "rest-api.md", "plugins.md"]),
  examples: new Set(["rest-curl", "one-shot-cli", "plugin-search-engine"]),
};
const GH = "https://github.com/KnockOutEZ/wigolo";

test("doc-to-doc links stay relative so the docs site turns them into routes", () => {
  const out = rewriteLinks("See [REST](./rest-api.md#auth).", "docs/tools.md", "tools.md", known);
  assert.equal(out, "See [REST](./rest-api.md#auth).");
});

test("the docs index is README.md on GitHub but index.md on the site", () => {
  const out = rewriteLinks("[Back](./README.md)", "docs/tools.md", "tools.md", known);
  assert.equal(out, "[Back](./index.md)");
});

test("a doc linking into examples/ reaches the example's page, not GitHub", () => {
  const out = rewriteLinks("[plugin](../examples/plugin-search-engine/)", "docs/plugins.md", "plugins.md", known);
  assert.equal(out, "[plugin](./examples/plugin-search-engine/index.md)");
});

test("examples link to each other through their index pages", () => {
  const out = rewriteLinks("[curl](../rest-curl/)", "examples/one-shot-cli/README.md", "examples/one-shot-cli/index.md", known);
  assert.equal(out, "[curl](../rest-curl/index.md)");
});

test("files outside the docs set go to GitHub instead of a dead site URL", () => {
  assert.equal(
    rewriteLinks("[sec](../SECURITY.md)", "docs/privacy-security.md", "privacy-security.md", known),
    `[sec](${GH}/blob/main/SECURITY.md)`,
  );
  assert.equal(
    rewriteLinks("[pkg](../packaging/)", "docs/installation.md", "installation.md", known),
    `[pkg](${GH}/tree/main/packaging)`,
  );
  assert.equal(
    rewriteLinks("[wf](./workflow.json)", "examples/n8n-remote-mcp/README.md", "examples/n8n-remote-mcp/index.md", known),
    `[wf](${GH}/blob/main/examples/n8n-remote-mcp/workflow.json)`,
  );
});

test("a directory link without a trailing slash is still a tree URL", () => {
  const out = rewriteLinks("[mcpb](../mcpb)", "docs/installation.md", "installation.md", known, (p) => p === "mcpb");
  assert.equal(out, `[mcpb](${GH}/tree/main/mcpb)`);
});

test("example demo gifs stay local, since they are copied next to the page", () => {
  const out = rewriteLinks("![demo](demo.gif)", "examples/one-shot-cli/README.md", "examples/one-shot-cli/index.md", known);
  assert.equal(out, "![demo](./demo.gif)");
});

test("absolute URLs, anchors and code blocks are left alone", () => {
  const md = "[x](https://a.b) [y](#h)\n```\n[z](./rest-api.md)\n```";
  assert.equal(rewriteLinks(md, "docs/tools.md", "tools.md", known), md);
});

test("an unknown doc is not linked as a site page", () => {
  assert.equal(contentPathFor("docs/nope.md", known), null);
});

test("the title comes from the first h1 outside code and is removed from the body", () => {
  const { title, body } = takeTitle("```\n# not me\n```\n# Tools\n\nBody");
  assert.equal(title, "Tools");
  assert.ok(!body.includes("# Tools"));
  assert.ok(body.includes("# not me"));
});

test("the index table yields order and descriptions", () => {
  const rows = parseIndexTable("| Page | x |\n| --- | --- |\n| [Tools](./tools.md) | The 10 tools. |\n| [L](../LICENSING.md) | no |");
  assert.deepEqual(rows, [{ label: "Tools", target: "tools.md", description: "The 10 tools." }]);
});

test("meta descriptions are plain text and bounded", () => {
  const d = firstParagraph("wigolo is a **local-first** [server](./x.md) " + "word ".repeat(60), 80);
  assert.ok(d.length <= 80);
  assert.ok(!d.includes("*") && !d.includes("]("));
});

test("fence tracking ignores a different fence char inside a block", () => {
  const seen = [];
  mapOutsideFences("a\n```\n~~~\nb\n```\nc", (l) => (seen.push(l), l));
  assert.deepEqual(seen, ["a", "c"]);
});

test("a table-cell description loses its markdown and pipe escapes", () => {
  // Otherwise the page subtitle and meta description read "--json \\| jq".
  assert.equal(flatten("the `--json \\| jq` [contract](./x.md)"), "the --json | jq contract");
});
