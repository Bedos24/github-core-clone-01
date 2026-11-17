// The forge's HTTP surface, assembled: the env's health probe, git smart HTTP, REST v3,
// GraphQL and MCP over one shared in-memory store. app.ts is the server; main.ts owns the
// entry <-> env lifecycle and stays as the starter shipped it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { makeCtx, sendJson } from './http.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const ctx = makeCtx(req, res, token);
    void (async () => {
      try {
        const seg = ctx.segments;
        if (ctx.method === 'GET' && ctx.path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (seg[0] === 'api' && seg[1] === 'v3') {
          await handleRest(forge, ctx);
          return;
        }
        if (seg[0] === 'api' && seg[1] === 'graphql') {
          await handleGraphQL(forge, ctx);
          return;
        }
        if (seg[0] === 'mcp') {
          await handleMcp(forge, ctx);
          return;
        }
        if (seg.length >= 2 && seg[1]!.endsWith('.git')) {
          await handleGit(forge, ctx);
          return;
        }
        sendJson(ctx, 404, { message: 'Not Found' });
      } catch {
        // One bad request must never take the forge down.
        if (!res.headersSent) sendJson(ctx, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
