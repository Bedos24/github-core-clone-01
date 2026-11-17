// A GraphQL subset aimed at the suite's fixed documents: named query/mutation operations,
// variables (including input objects), aliases, inline fragments, connections with cursor
// pagination, the mutations the checks drive (createIssue, closeIssue, createPullRequest,
// mergePullRequest, addComment), node(id:), and __type introspection for the types the suite
// names. Unknown fields answer HTTP 200 with an errors entry naming the field, as GitHub does.

import {
  Forge,
  VIEWER,
  branchTip,
  createIssue,
  createPull,
  diffTrees,
  fullName,
  globalId,
  mergePull,
  parseGlobalId,
  pullConflicts,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { authed, readBody, sendJson, type Ctx } from './http.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'variable'; name: string };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: Selection[] | null;
}
interface FragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  selection: Selection[];
}
interface SpreadSel {
  kind: 'spread';
  name: string;
}
type Selection = FieldSel | FragmentSel | SpreadSel;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end < 0 ? source.length : end)}"`);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const rest = source.slice(i);
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (numMatch !== null) {
      tokens.push(numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && /^[_A-Za-z]/.test(maybeName) && maybeName !== '(' && maybeName !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        // Directives on the operation are not used by the suite; skip any.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced('(', ')');
        }
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // type condition
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          selections.push({ kind: 'fragment', typeCondition: typeName, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, Value> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      while (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('}');
    return selections;
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = evalValue(inner, variables);
      return out;
    }
    case 'variable':
      return variables[value.name];
  }
}

// ---------------------------------------------------------------- object wrappers

interface Wrap {
  type: string;
  repo?: RepoRec;
  issue?: IssueRec;
  pull?: PullRec;
  commentId?: number;
  holderNumber?: number;
  name?: string;
  oid?: string;
  items?: Wrap[];
  totalCount?: number;
  first?: number;
  afterIndex?: number;
  node?: Wrap;
  cursor?: string;
  change?: { filename: string; additions: number; deletions: number; status: string };
  payloadIssue?: IssueRec | null;
  payloadPull?: PullRec | null;
  payloadComment?: { edge: Wrap; subject: Wrap } | null;
}

const userWrap = (): Wrap => ({ type: 'User' });
const repoWrap = (repo: RepoRec): Wrap => ({ type: 'Repository', repo });
const issueWrap = (repo: RepoRec, issue: IssueRec): Wrap => ({ type: 'Issue', repo, issue });
const pullWrap = (repo: RepoRec, pull: PullRec): Wrap => ({ type: 'PullRequest', repo, pull });

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function connection(items: Wrap[], args: Record<string, unknown>): Wrap {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match !== null) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  return { type: 'Connection', items, totalCount: items.length, first, afterIndex: start };
}

function connectionSlice(wrap: Wrap): { page: Wrap[]; start: number; hasNext: boolean } {
  const all = wrap.items ?? [];
  const start = wrap.afterIndex ?? 0;
  const page = all.slice(start, start + (wrap.first ?? all.length));
  return { page, start, hasNext: start + page.length < all.length };
}

// ---------------------------------------------------------------- introspection registry

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author',
    'repository', 'createdAt', 'updatedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'comments', 'author', 'repository',
    'mergedAt', 'mergeCommit', 'createdAt', 'updatedAt', 'url',
  ],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Commit: ['oid'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------- execution

interface ExecState {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, Selection[]>;
}

function argsOf(sel: FieldSel, state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sel.args)) out[key] = evalValue(value, state.variables);
  return out;
}

function executeSelectionSet(state: ExecState, typeName: string, source: Wrap | null, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(state, typeName, source, sel.selection));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = state.fragments.get(sel.name);
      if (frag !== undefined) Object.assign(out, executeSelectionSet(state, typeName, source, frag));
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = executeField(state, typeName, source, sel);
  }
  return out;
}

function executeField(state: ExecState, typeName: string, source: Wrap | null, sel: FieldSel): unknown {
  const resolver = RESOLVERS[typeName]?.[sel.name];
  if (resolver === undefined) {
    state.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  const value = resolver(state, source, sel);
  if (value === null || value === undefined) return null;
  if (sel.selection !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item) =>
        item !== null && typeof item === 'object' && 'type' in (item as Wrap)
          ? executeSelectionSet(state, (item as Wrap).type, item as Wrap, sel.selection!)
          : item,
      );
    }
    const wrap = value as Wrap;
    if (typeof wrap.type === 'string') return executeSelectionSet(state, wrap.type, wrap, sel.selection);
  }
  return value;
}

type Resolver = (state: ExecState, source: Wrap | null, sel: FieldSel) => unknown;

function repoOf(source: Wrap | null): RepoRec {
  return source!.repo!;
}

/** Find a repository by its database id (GraphQL global ids and node()). */
function repoByDatabaseId(forge: Forge, databaseId: number): RepoRec | undefined {
  return forge.listRepos().find((repo) => repo.id === databaseId);
}

function resolveNode(forge: Forge, id: string): Wrap | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'User') return userWrap();
  if (parsed.type === 'Repository') {
    const repo = repoByDatabaseId(forge, Number(parsed.key));
    return repo === undefined ? null : repoWrap(repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':').map(Number);
    const repo = repoByDatabaseId(forge, repoId!);
    if (repo === undefined) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number!);
      return issue === undefined ? null : issueWrap(repo, issue);
    }
    const pull = repo.pulls.get(number!);
    return pull === undefined ? null : pullWrap(repo, pull);
  }
  if (parsed.type === 'Comment') {
    const [repoId, holderNumber, commentId] = parsed.key.split(':').map(Number);
    const repo = repoByDatabaseId(forge, repoId!);
    if (repo === undefined) return null;
    const holder = repo.issues.get(holderNumber!) ?? repo.pulls.get(holderNumber!);
    if (holder === undefined) return null;
    const comment = holder.comments.find((candidate) => candidate.id === commentId);
    if (comment === undefined) return null;
    return { type: 'Comment', repo, holderNumber, commentId, name: comment.body };
  }
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userWrap(),
    repository: (state, _source, sel) => {
      const args = argsOf(sel, state);
      const repo = state.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoWrap(repo);
    },
    node: (state, _source, sel) => {
      const args = argsOf(sel, state);
      return resolveNode(state.forge, String(args.id ?? ''));
    },
    __type: (_state, _source, sel) => {
      const args = argsOf(sel, { ..._state, variables: _state.variables });
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined || ENUM_TYPES[name] !== undefined) return { type: '__Type', name };
      return null;
    },
    __schema: () => ({ type: '__Schema' }),
    search: () => connection([], {}),
  },

  Mutation: {
    createIssue: (state, _source, sel) => {
      const input = (argsOf(sel, state).input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDatabaseId(state.forge, Number(parsed.key)) : undefined;
      if (repo === undefined) {
        state.errors.push({ message: 'repository not found for createIssue' });
        return { type: 'CreateIssuePayload', payloadIssue: null };
      }
      const issue = createIssue(state.forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { type: 'CreateIssuePayload', repo, payloadIssue: issue };
    },
    closeIssue: (state, _source, sel) => {
      const input = (argsOf(sel, state).input ?? {}) as Record<string, unknown>;
      const target = resolveNode(state.forge, String(input.issueId ?? ''));
      if (target === null || target.type !== 'Issue') {
        state.errors.push({ message: 'issue not found for closeIssue' });
        return { type: 'CloseIssuePayload', payloadIssue: null };
      }
      target.issue!.state = 'closed';
      target.issue!.updatedAt = new Date().toISOString();
      return { type: 'CloseIssuePayload', repo: target.repo, payloadIssue: target.issue };
    },
    createPullRequest: (state, _source, sel) => {
      const input = (argsOf(sel, state).input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDatabaseId(state.forge, Number(parsed.key)) : undefined;
      if (repo === undefined) {
        state.errors.push({ message: 'repository not found for createPullRequest' });
        return { type: 'CreatePullRequestPayload', payloadPull: null };
      }
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === String(input.headRefName) && pull.baseRef === String(input.baseRefName),
      );
      if (existing !== undefined) return { type: 'CreatePullRequestPayload', repo, payloadPull: existing };
      const pull = createPull(state.forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (pull === null) {
        state.errors.push({ message: 'head or base branch not found for createPullRequest' });
        return { type: 'CreatePullRequestPayload', payloadPull: null };
      }
      return { type: 'CreatePullRequestPayload', repo, payloadPull: pull };
    },
    mergePullRequest: (state, _source, sel) => {
      const input = (argsOf(sel, state).input ?? {}) as Record<string, unknown>;
      const target = resolveNode(state.forge, String(input.pullRequestId ?? ''));
      if (target === null || target.type !== 'PullRequest') {
        state.errors.push({ message: 'pull request not found for mergePullRequest' });
        return { type: 'MergePullRequestPayload', payloadPull: null };
      }
      const repo = target.repo!;
      const pull = target.pull!;
      if (!pull.merged) {
        const sha = mergePull(repo, pull, 'squash');
        if (sha === null) state.errors.push({ message: 'Pull Request is not mergeable' });
      }
      return { type: 'MergePullRequestPayload', repo, payloadPull: pull };
    },
    addComment: (state, _source, sel) => {
      const input = (argsOf(sel, state).input ?? {}) as Record<string, unknown>;
      const target = resolveNode(state.forge, String(input.subjectId ?? ''));
      if (target === null || (target.type !== 'Issue' && target.type !== 'PullRequest')) {
        state.errors.push({ message: 'subject not found for addComment' });
        return { type: 'AddCommentPayload', payloadComment: null };
      }
      const repo = target.repo!;
      const holder = target.type === 'Issue' ? target.issue! : target.pull!;
      const comment = { id: state.forge.allocCommentId(), body: String(input.body ?? ''), createdAt: new Date().toISOString() };
      holder.comments.push(comment);
      const commentWrap: Wrap = { type: 'Comment', repo, holderNumber: holder.number, commentId: comment.id, name: comment.body };
      const edge: Wrap = { type: 'CommentEdge', node: commentWrap, cursor: cursorOf(0) };
      return { type: 'AddCommentPayload', payloadComment: { edge, subject: target } };
    },
  },

  CreateIssuePayload: {
    issue: (_state, source) => (source?.payloadIssue ? issueWrap(source.repo!, source.payloadIssue) : null),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (_state, source) => (source?.payloadIssue ? issueWrap(source.repo!, source.payloadIssue) : null),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_state, source) => (source?.payloadPull ? pullWrap(source.repo!, source.payloadPull) : null),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (_state, source) => (source?.payloadPull ? pullWrap(source.repo!, source.payloadPull) : null),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (_state, source) => source?.payloadComment?.edge ?? null,
    subject: (_state, source) => source?.payloadComment?.subject ?? null,
    clientMutationId: () => null,
  },
  CommentEdge: {
    node: (_state, source) => source?.node ?? null,
    cursor: (_state, source) => source?.cursor ?? '',
  },

  User: {
    login: () => VIEWER.login,
    id: () => globalId('User', String(VIEWER.id)),
    databaseId: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },

  Repository: {
    id: (_state, source) => globalId('Repository', String(repoOf(source).id)),
    databaseId: (_state, source) => repoOf(source).id,
    name: (_state, source) => repoOf(source).name,
    nameWithOwner: (_state, source) => fullName(repoOf(source)),
    description: (_state, source) => repoOf(source).description,
    isPrivate: (_state, source) => repoOf(source).isPrivate,
    owner: () => userWrap(),
    defaultBranchRef: (_state, source) => {
      const repo = repoOf(source);
      return branchTip(repo, repo.defaultBranch) === undefined ? null : { type: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (_state, source) => repoOf(source).createdAt,
    updatedAt: (_state, source) => repoOf(source).updatedAt,
    url: (_state, source) => `/${fullName(repoOf(source))}`,
    issue: (_state, source, sel) => {
      const args = argsOf(sel, _state);
      const issue = repoOf(source).issues.get(Number(args.number));
      return issue === undefined ? null : issueWrap(repoOf(source), issue);
    },
    issues: (state, source, sel) => {
      const args = argsOf(sel, state);
      const repo = repoOf(source);
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return connection(issues.map((issue) => issueWrap(repo, issue)), args);
    },
    pullRequest: (_state, source, sel) => {
      const args = argsOf(sel, _state);
      const pull = repoOf(source).pulls.get(Number(args.number));
      return pull === undefined ? null : pullWrap(repoOf(source), pull);
    },
    pullRequests: (state, source, sel) => {
      const args = argsOf(sel, state);
      const repo = repoOf(source);
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      pulls = pulls.filter((pull) => {
        const gqlState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
        return states.includes(gqlState);
      });
      pulls.sort((a, b) => a.number - b.number);
      return connection(pulls.map((pull) => pullWrap(repo, pull)), args);
    },
  },

  Ref: {
    name: (_state, source) => source?.name ?? '',
    target: () => null,
  },

  Issue: {
    id: (_state, source) => globalId('Issue', `${source!.repo!.id}:${source!.issue!.number}`),
    databaseId: (_state, source) => source!.issue!.id,
    number: (_state, source) => source!.issue!.number,
    title: (_state, source) => source!.issue!.title,
    body: (_state, source) => source!.issue!.body,
    state: (_state, source) => source!.issue!.state.toUpperCase(),
    author: () => userWrap(),
    repository: (_state, source) => repoWrap(source!.repo!),
    createdAt: (_state, source) => source!.issue!.createdAt,
    updatedAt: (_state, source) => source!.issue!.updatedAt,
    url: (_state, source) => `/${fullName(source!.repo!)}/issues/${source!.issue!.number}`,
    labels: (_state, source, sel) => {
      const repo = source!.repo!;
      const items = source!.issue!.labels.map((name) => ({
        type: 'Label',
        name,
        repo,
      }));
      return connection(items as Wrap[], argsOf(sel, _state));
    },
    comments: (_state, source, sel) => {
      const repo = source!.repo!;
      const issue = source!.issue!;
      const items = issue.comments.map((comment) => ({
        type: 'Comment',
        repo,
        holderNumber: issue.number,
        commentId: comment.id,
        name: comment.body,
      }));
      return connection(items as Wrap[], argsOf(sel, _state));
    },
  },

  PullRequest: {
    id: (_state, source) => globalId('PullRequest', `${source!.repo!.id}:${source!.pull!.number}`),
    databaseId: (_state, source) => source!.pull!.id,
    number: (_state, source) => source!.pull!.number,
    title: (_state, source) => source!.pull!.title,
    body: (_state, source) => source!.pull!.body,
    state: (_state, source) => (source!.pull!.merged ? 'MERGED' : source!.pull!.state.toUpperCase()),
    merged: (_state, source) => source!.pull!.merged,
    mergeable: (_state, source) => {
      const pull = source!.pull!;
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(source!.repo!, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (_state, source) => source!.pull!.headRef,
    baseRefName: (_state, source) => source!.pull!.baseRef,
    headRefOid: (_state, source) => branchTip(source!.repo!, source!.pull!.headRef) ?? source!.pull!.headSha,
    baseRefOid: (_state, source) => branchTip(source!.repo!, source!.pull!.baseRef) ?? source!.pull!.baseSha,
    mergedAt: (_state, source) => source!.pull!.mergedAt,
    mergeCommit: (_state, source) =>
      source!.pull!.mergeCommitSha === null ? null : { type: 'Commit', oid: source!.pull!.mergeCommitSha },
    author: () => userWrap(),
    repository: (_state, source) => repoWrap(source!.repo!),
    createdAt: (_state, source) => source!.pull!.createdAt,
    updatedAt: (_state, source) => source!.pull!.updatedAt,
    url: (_state, source) => `/${fullName(source!.repo!)}/pull/${source!.pull!.number}`,
    files: (_state, source, sel) => {
      const pull = source!.pull!;
      const items = diffTrees(pull.baseSha, pull.headSha).map((change) => ({
        type: 'PullRequestChangedFile',
        change: { filename: change.filename, additions: change.additions, deletions: change.deletions, status: change.status },
      }));
      return connection(items as Wrap[], argsOf(sel, _state));
    },
    comments: (_state, source, sel) => {
      const repo = source!.repo!;
      const pull = source!.pull!;
      const items = pull.comments.map((comment) => ({
        type: 'Comment',
        repo,
        holderNumber: pull.number,
        commentId: comment.id,
        name: comment.body,
      }));
      return connection(items as Wrap[], argsOf(sel, _state));
    },
  },

  PullRequestChangedFile: {
    path: (_state, source) => source!.change!.filename,
    additions: (_state, source) => source!.change!.additions,
    deletions: (_state, source) => source!.change!.deletions,
    changeType: (_state, source) => source!.change!.status.toUpperCase(),
  },

  Comment: {
    id: (_state, source) => globalId('Comment', `${source!.repo!.id}:${source!.holderNumber}:${source!.commentId}`),
    body: (_state, source) => source!.name ?? '',
    author: () => userWrap(),
    createdAt: (_state, source) => {
      const holder = source!.repo!.issues.get(source!.holderNumber!) ?? source!.repo!.pulls.get(source!.holderNumber!);
      return holder?.comments.find((comment) => comment.id === source!.commentId)?.createdAt ?? null;
    },
    updatedAt: (_state, source) => {
      const holder = source!.repo!.issues.get(source!.holderNumber!) ?? source!.repo!.pulls.get(source!.holderNumber!);
      return holder?.comments.find((comment) => comment.id === source!.commentId)?.createdAt ?? null;
    },
  },

  Label: {
    id: (_state, source) => globalId('Label', source!.name ?? ''),
    name: (_state, source) => source!.name ?? '',
    color: (_state, source) => source!.repo?.labels.get((source!.name ?? '').toLowerCase())?.color ?? '000000',
  },

  Commit: {
    oid: (_state, source) => source!.oid ?? '',
  },

  Connection: {
    nodes: (_state, source) => connectionSlice(source!).page,
    edges: (_state, source) => {
      const { page, start } = connectionSlice(source!);
      return page.map((node, index) => ({ type: 'Edge', node, cursor: cursorOf(start + index) }));
    },
    pageInfo: (_state, source) => {
      const { page, start, hasNext } = connectionSlice(source!);
      return {
        type: 'PageInfo',
        name: JSON.stringify({
          hasNextPage: hasNext,
          hasPreviousPage: start > 0,
          startCursor: page.length > 0 ? cursorOf(start) : null,
          endCursor: page.length > 0 ? cursorOf(start + page.length - 1) : null,
        }),
      };
    },
    totalCount: (_state, source) => source!.totalCount ?? 0,
  },

  Edge: {
    node: (_state, source) => source!.node ?? null,
    cursor: (_state, source) => source!.cursor ?? '',
  },

  PageInfo: {
    hasNextPage: (_state, source) => (JSON.parse(source!.name!) as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (_state, source) => (JSON.parse(source!.name!) as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (_state, source) => (JSON.parse(source!.name!) as { startCursor: string | null }).startCursor,
    endCursor: (_state, source) => (JSON.parse(source!.name!) as { endCursor: string | null }).endCursor,
  },

  __Type: {
    name: (_state, source) => source!.name!,
    kind: (_state, source) => (ENUM_TYPES[source!.name!] !== undefined ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (_state, source) => {
      const fields = TYPE_FIELDS[source!.name!];
      if (fields === undefined) return null;
      return fields.map((name) => ({ type: '__Field', name }));
    },
    enumValues: (_state, source) => {
      const values = ENUM_TYPES[source!.name!];
      if (values === undefined) return null;
      return values.map((name) => ({ type: '__EnumValue', name }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    specifiedByURL: () => null,
  },

  __Field: {
    name: (_state, source) => source!.name!,
    description: () => null,
    args: () => [],
    type: () => ({ type: '__Type', name: 'String' }),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },

  __EnumValue: {
    name: (_state, source) => source!.name!,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },

  __Schema: {
    types: () => Object.keys(TYPE_FIELDS).map((name) => ({ type: '__Type', name })),
    queryType: () => ({ type: '__Type', name: 'Query' }),
    mutationType: () => ({ type: '__Type', name: 'Mutation' }),
    directives: () => [],
  },
};

// ---------------------------------------------------------------- HTTP entry

function executeOne(forge: Forge, body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const state: ExecState = { forge, variables, errors: [], fragments: document.fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(state, rootType, { type: rootType }, operation.selection);
  const result: Record<string, unknown> = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

export async function handleGraphQL(forge: Forge, ctx: Ctx): Promise<void> {
  if (!authed(ctx)) {
    sendJson(ctx, 401, { message: 'Bad credentials' });
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 400, { errors: [{ message: 'GraphQL only accepts POST' }] });
    return;
  }
  const raw = await readBody(ctx.req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOne(forge, entry as Record<string, unknown>) : { errors: [{ message: 'invalid operation' }] },
    );
    sendJson(ctx, 200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(ctx, 400, { errors: [{ message: 'invalid GraphQL request' }] });
    return;
  }
  sendJson(ctx, 200, executeOne(forge, parsed as Record<string, unknown>));
}
