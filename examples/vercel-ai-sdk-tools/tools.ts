/**
 * wigolo as Vercel AI SDK tools.
 *
 * `WigoloMcpClient` talks to a wigolo instance it spawns itself (over the MCP
 * protocol on stdio — `npx wigolo` by default), and `createWigoloTools` wraps
 * the wigolo tool surface as ready-to-register AI SDK tools.
 *
 *   npm install
 *   npm run demo
 */
import { z } from 'zod';
import { WigoloMcpClient, createWigoloTools } from 'wigolo-vercel-ai-sdk';

// Default spawn is `npx wigolo`. Point WIGOLO_MCP_COMMAND / WIGOLO_MCP_ARGS at
// another entry point (e.g. a global install or a local build) if you prefer.
const client = new WigoloMcpClient(
  process.env.WIGOLO_MCP_COMMAND
    ? {
        command: process.env.WIGOLO_MCP_COMMAND,
        args: process.env.WIGOLO_MCP_ARGS ? process.env.WIGOLO_MCP_ARGS.split(' ') : [],
      }
    : undefined,
);

await client.connect();
console.log('connected to wigolo over MCP (stdio)');

const tools = createWigoloTools(client);

console.log(`\nregistered ${Object.keys(tools).length} tools:\n`);
for (const [name, t] of Object.entries(tools)) {
  const params = t.parameters instanceof z.ZodObject ? Object.keys(t.parameters.shape) : [];
  const firstSentence = (t.description ?? '').split('. ')[0];
  console.log(`- ${name}(${params.slice(0, 4).join(', ')}${params.length > 4 ? ', ...' : ''})`);
  console.log(`    ${firstSentence}.`);
}

// With any AI SDK model provider wired up, handing the model live web access
// is one property:
//
//   import { generateText } from 'ai';
//   import { anthropic } from '@ai-sdk/anthropic';   // or any provider
//
//   const { text } = await generateText({
//     model: anthropic('claude-sonnet-4-5'),
//     tools,                       // <- the wigolo tools registered above
//     maxSteps: 5,
//     prompt: 'What changed in the latest TypeScript release? Cite sources.',
//   });
//
// The model decides when to call webSearch / webFetch / research; wigolo does
// the gathering locally and returns structured, citable results.

await client.disconnect();
console.log('\ndisconnected — wigolo subprocess stopped');
