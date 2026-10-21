import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALTERNATIVES } from "@/content/alternatives";
import { source } from "@/lib/source";
import { SITE_URL } from "@/lib/site";

// Hand-written product summary (install steps, MCP setup, positioning) that
// leads both files; the docs sections below it are generated from content.
const preamble = () =>
  readFileSync(join(process.cwd(), "src", "content", "llms-preamble.md"), "utf8").trimEnd();

type TreeNode = { type: string; url?: string; index?: { url: string }; children?: TreeNode[] };

/** Page URLs in sidebar order, so both files read like the docs. */
function treeOrder(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "page" && n.url) out.push(n.url);
    if (n.type === "folder") {
      if (n.index) out.push(n.index.url);
      treeOrder(n.children ?? [], out);
    }
  }
  return out;
}

const pages = () => {
  const order = treeOrder(source.pageTree.children as TreeNode[]);
  const rank = (url: string) => (order.indexOf(url) === -1 ? order.length : order.indexOf(url));
  return [...source.getPages()].sort((a, b) => rank(a.url) - rank(b.url)).map((p) => ({
    page: p,
    url: `${SITE_URL}${p.url}/`,
    title: p.data.title,
    description: p.data.description ?? "",
  }));
};

/** llms.txt: the summary plus a linked index of every docs page. */
export function llmsIndex(): string {
  const all = pages();
  const docs = all.filter((p) => p.page.slugs[0] !== "examples");
  const examples = all.filter((p) => p.page.slugs[0] === "examples");
  const list = (items: typeof all) =>
    items.map((p) => `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}`).join("\n");
  return [
    preamble(),
    "",
    "## Docs",
    "",
    list(docs),
    "",
    "## Examples",
    "",
    list(examples),
    "",
    "## Comparisons",
    "",
    ALTERNATIVES.map((a) => `- [wigolo vs ${a.name}](${SITE_URL}/alternatives/${a.slug}/): ${a.description}`).join("\n"),
    "",
    "## Optional",
    "",
    `- [Full docs in one file](${SITE_URL}/llms-full.txt): every page above as plain markdown`,
    "",
  ].join("\n");
}

/** llms-full.txt: the summary plus every docs page's full markdown. */
export async function llmsFull(): Promise<string> {
  const bodies = await Promise.all(
    pages().map(async (p) => `# ${p.title}\n\nSource: ${p.url}\n\n${(await p.page.data.getText("processed")).trim()}`),
  );
  return `${preamble()}\n\n${bodies.join("\n\n---\n\n")}\n`;
}
