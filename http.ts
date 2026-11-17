// Shared HTTP plumbing for every surface: request context, JSON answers with the headers the
// protocol checks sample, bearer auth, and body reading. Every response this forge sends —
// success or error — is JSON with a non-empty X-GitHub-Request-Id, never HTML.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A fresh, non-empty request id (the protocol checks only require presence). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${randomBytes(6).toString('hex')}`;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** The token this deployment grades against; empty means "no token configured" (local dev). */
  token: string;
  method: string;
  /** Decoded path segments of the request URL. */
  segments: string[];
  /** The raw path (no query), undecoded. */
  path: string;
  query: URLSearchParams;
  /** The request's origin as the client addressed it, for absolute pagination links. */
  origin: string;
}

export function makeCtx(req: IncomingMessage, res: ServerResponse, token: string): Ctx {
  const url = new URL(req.url ?? '/', 'http://entry');
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const host = req.headers.host ?? '127.0.0.1';
  return {
    req,
    res,
    token,
    method: (req.method ?? 'GET').toUpperCase(),
    segments,
    path: url.pathname,
    query: url.searchParams,
    origin: `http://${host}`,
  };
}

/** Whether the request carries the deployment's bearer token. */
export function authed(ctx: Ctx): boolean {
  if (ctx.token === '') return true;
  const header = ctx.req.headers.authorization ?? '';
  return header === `Bearer ${ctx.token}` || header === `token ${ctx.token}`;
}

/** Send a JSON body with the forge's standard headers. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  ctx.res.end(text);
}

/** Send raw bytes (git protocol answers) with an explicit content type. */
export function sendBytes(ctx: Ctx, status: number, body: Buffer, contentType: string): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  ctx.res.end(body);
}

/** A GitHub-shaped error: a JSON object with a string `message`. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON request body. Returns {ok:true, value} (empty body reads as {}), or sends the
 * 400 the protocol checks require for malformed JSON and returns {ok:false}.
 */
export async function readJsonBody(ctx: Ctx): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(ctx.req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return { ok: false };
  }
}

/** A query parameter as a positive int, or the fallback. */
export function intParam(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
