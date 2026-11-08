/**
 * Drives a running Fancy Mail server's MCP endpoint like an agent would, over real HTTP.
 * Usage: node scripts/electron-node.mjs apps/server/scripts/mcp-smoke.ts <url> <token>
 * The token is in Settings › Agents (or the kv table of the data dir's database).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url = "http://127.0.0.1:47830/mcp", token = ""] = process.argv.slice(2);
const client = new Client({ name: "fancy-mail-smoke", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}`);

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n### ${name} ${JSON.stringify(args)}  (${text.length} chars${result.isError ? ", ERROR" : ""})`);
  console.log(text.length > 1800 ? `${text.slice(0, 1800)}\n…` : text);
  return text;
}

await call("mail_overview");
const invoices = await call("mail_search", { query: "has:attachment -label:Invoices group:Business newer_than:3m", limit: 5 });
const threadId = /thr_[a-z0-9]+/.exec(invoices)?.[0];
if (threadId) {
  const thread = await call("mail_read_thread", { thread_id: threadId, max_chars_per_message: 600 });
  const attachmentId = /att_[a-z0-9]+/.exec(thread)?.[0];
  if (attachmentId) await call("mail_get_attachment", { attachment_id: attachmentId });
}
const organized = await call("mail_organize", {
  query: "label:Newsletters older_than:30d in:inbox",
  actions: [{ type: "archive" }],
});
const activityId = /act_[a-z0-9]+/.exec(organized)?.[0];
if (activityId) await call("mail_activity", { action: "undo", activity_id: activityId });
await call("mail_activity", { action: "list", limit: 5 });
await call("mail_search", { query: "label:Nonexistent" });
await client.close();
