// The MCP endpoint: streamable-HTTP JSON-RPC at POST /mcp. Both protocol eras are served —
// modern `server/discover` and the legacy initialize handshake — with the six forge tools the
// suite drives. Tool results mirror the REST objects exactly (same store), which is what the
// suite's MCP<->REST parity checks compare.

import {
  Forge,
  createIssue,
  createPull,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  type RepoRec,
} from './store.ts';
import { authed, readBody, sendJson, type Ctx } from './http.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function repoByArgs(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (name === '') return null;
  return forge.getRepoByName(name) ?? null;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = String(args.name ?? '');
      if (forge.getRepoByName(name) !== undefined) throw new Error(`repository '${name}' already exists`);
      const repo = forge.createRepo({
        name,
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoByArgs(forge, args);
      if (repo === null) throw new Error('repository not found');
      return repoJson(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = repoByArgs(forge, args);
      if (repo === null) throw new Error('repository not found');
      const issue = createIssue(forge, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoByArgs(forge, args);
      if (repo === null) throw new Error('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { issues: issues.map((issue) => issueJson(repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = repoByArgs(forge, args);
      if (repo === null) throw new Error('repository not found');
      const pull = createPull(forge, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
      });
      if (pull === null) throw new Error('head or base branch not found');
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
        merge_method: stringProp('The merge method: merge or squash.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoByArgs(forge, args);
      if (repo === null) throw new Error('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error('pull request not found');
      if (!pull.merged) {
        const sha = mergePull(repo, pull, args.merge_method === 'merge' ? 'merge' : 'squash');
        if (sha === null) throw new Error('Pull Request is not mergeable');
      }
      return pullJson(repo, pull);
    },
  },
];

/** The tools/list answer, built once so repeated calls are byte-identical. */
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
});

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  const text = Array.isArray((payload as { issues?: unknown }).issues)
    ? JSON.stringify((payload as { issues: unknown[] }).issues)
    : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export async function handleMcp(forge: Forge, ctx: Ctx): Promise<void> {
  if (ctx.method === 'DELETE') {
    sendJson(ctx, 200, undefined);
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (!authed(ctx)) {
    sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const raw = await readBody(ctx.req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleRpc(forge, entry))
      .filter((entry) => entry !== null);
    sendJson(ctx, 200, responses);
    return;
  }
  const response = handleRpc(forge, parsed);
  if (response === null) {
    // A notification: accepted, nothing to answer.
    ctx.res.writeHead(202, { 'x-github-request-id': 'mcp-notification' });
    ctx.res.end();
    return;
  }
  sendJson(ctx, 200, response);
}

function handleRpc(forge: Forge, entry: unknown): Record<string, unknown> | null {
  if (typeof entry !== 'object' || entry === null) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const request = entry as { id?: unknown; method?: unknown; params?: unknown };
  const isNotification = request.id === undefined;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  const ok = (result: unknown): Record<string, unknown> | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } };

  switch (method) {
    case 'server/discover':
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize':
      return ok({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'tools/list':
      return ok(JSON.parse(TOOLS_LIST_JSON) as unknown);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return fail(-32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return ok(toolError(`missing required argument: ${key}`));
        }
      }
      try {
        return ok(toolResult(tool.run(forge, args)));
      } catch (error) {
        return ok(toolError(error instanceof Error ? error.message : String(error)));
      }
    }
    case 'ping':
      return ok({});
    default:
      if (method.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}
