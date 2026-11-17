// The forge's data model: one viewer, their repositories, and each repository's refs, labels,
// issues, pull requests and comments. Git objects live in gitobj.ts's store; a repository is
// refs + metadata over that store. REST, GraphQL and MCP all read and write through here so the
// three surfaces can never disagree about an object.

import {
  buildTreeFromFlat,
  flattenTree,
  getObject,
  isAncestor,
  lookupPath,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  storeCommit,
  storeObject,
  ZERO_OID,
} from './gitobj.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The identity stamped on commits this forge creates itself (contents API, merges). */
export function forgeAuthorLine(): string {
  const now = Math.floor(Date.now() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${now} +0000`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  /** Globally unique id (REST `id`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Branch tips captured at creation, the "files changed" baseline. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name -> object id. */
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** One sequence shared by issues and pull requests, as on GitHub. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;

  createRepo(input: { name: string; description?: string; isPrivate?: boolean; defaultBranch?: string }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name: input.name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: input.defaultBranch !== undefined && input.defaultBranch !== '' ? input.defaultBranch : 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  /** A repository of the viewer's, by any-case name; undefined when it does not exist. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner.toLowerCase() !== VIEWER.login) return undefined;
    return this.repos.get(repoKey(VIEWER.login, name));
  }

  /** The viewer's repository by bare name (MCP tools address repos this way). */
  getRepoByName(name: string): RepoRec | undefined {
    return this.repos.get(repoKey(VIEWER.login, name));
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  allocIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function fullName(repo: RepoRec): string {
  return `${repo.owner}/${repo.name}`;
}

/** The tip of a branch, or undefined when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** The tree oid at a commit oid. */
export function commitTree(commitOid: string): string {
  const obj = getObject(commitOid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------- REST JSON shapes

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: fullName(repo),
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `/${fullName(repo)}`,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name.toLowerCase());
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** Opaque, stable GraphQL global ids: base64 of a typed payload, never the bare database id. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- issues and pulls

export function createIssue(forge: Forge, repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
  const issue: IssueRec = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(forge: Forge, repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec | null {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (headSha === undefined || baseSha === undefined) return null;
  const pull: PullRec = {
    id: forge.allocIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

// ---------------------------------------------------------------- file diffs and merges

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts via a longest-common-subsequence over lines (check files are small). */
export function diffCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const a = before === null ? [] : countLines(before);
  const b = after === null ? [] : countLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed-file list between two commits' trees. */
export function diffTrees(baseCommit: string, headCommit: string): FileChange[] {
  const baseFiles = flattenTree(commitTree(baseCommit));
  const headFiles = flattenTree(commitTree(headCommit));
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeData = before === undefined ? null : (getObject(before.oid)?.data ?? null);
    const afterData = after === undefined ? null : (getObject(after.oid)?.data ?? null);
    const { additions, deletions } = diffCounts(beforeData, afterData);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

export type MergeOutcome =
  | { ok: true; tree: string }
  | { ok: false; reason: string };

/**
 * A three-way tree merge: merge base vs current base tip vs current head tip, file by file.
 * A path conflicts when both sides changed it differently (including delete-vs-modify).
 */
export function threeWayMerge(repo: RepoRec, pull: PullRec): MergeOutcome {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'a branch is gone' };
  const baseCommit = peelToCommit(baseTip);
  const headCommit = peelToCommit(headTip);
  const ancestor = mergeBase(baseCommit, headCommit);
  const ancestorFiles = ancestor === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(commitTree(ancestor));
  const baseFiles = flattenTree(commitTree(baseCommit));
  const headFiles = flattenTree(commitTree(headCommit));
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const sameAB = a?.oid === b?.oid;
    const sameAH = a?.oid === h?.oid;
    const sameBH = b?.oid === h?.oid;
    if (sameBH) {
      if (b !== undefined) merged.set(path, b);
    } else if (sameAB) {
      if (h !== undefined) merged.set(path, h);
    } else if (sameAH) {
      if (b !== undefined) merged.set(path, b);
    } else {
      return { ok: false, reason: `conflict in ${path}` };
    }
  }
  return { ok: true, tree: buildTreeFromFlat(merged) };
}

/** Whether merging the pull now would conflict (GraphQL `mergeable`, REST merge 405). */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  if (pull.merged) return false;
  return !threeWayMerge(repo, pull).ok;
}

/**
 * Merge a pull request into its base branch. `squash` makes one commit with the base tip as
 * sole parent; `merge` makes a two-parent merge commit. Returns the new commit oid, or null
 * when the merge conflicts.
 */
export function mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): string | null {
  const outcome = threeWayMerge(repo, pull);
  if (!outcome.ok) return null;
  const baseTip = branchTip(repo, pull.baseRef)!;
  const headTip = branchTip(repo, pull.headRef)!;
  const baseCommit = peelToCommit(baseTip);
  const headCommit = peelToCommit(headTip);
  // Nothing to do fast path: head already contained in base.
  const line = forgeAuthorLine();
  const message =
    method === 'squash'
      ? `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd()
      : `Merge pull request #${pull.number}\n\n${pull.title}`;
  const sha = storeCommit({
    tree: outcome.tree,
    parents: method === 'squash' ? [baseCommit] : [baseCommit, headCommit],
    author: line,
    committer: line,
    message: `${message}\n`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  return sha;
}

// ---------------------------------------------------------------- contents API mechanics

export interface ContentsWriteResult {
  status: 201 | 200 | 409;
  blobSha: string;
  commitSha: string;
}

/**
 * Create or update one file on a branch, committing on top of the branch tip. An unborn branch
 * gets a root commit; a missing non-default branch is forked from the default branch's tip.
 * A stale `sha` (the file exists under a different blob id) is a 409.
 */
export function writeContents(
  repo: RepoRec,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentsWriteResult | null {
  const branch = input.branch !== undefined && input.branch !== '' ? input.branch : repo.defaultBranch;
  let tip = branchTip(repo, branch);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = branchTip(repo, repo.defaultBranch);
  }
  const path = input.path.replace(/^\/+/, '');
  if (path === '') return null;
  let files = new Map<string, { oid: string; mode: string }>();
  let parents: string[] = [];
  if (tip !== undefined) {
    const commit = peelToCommit(tip);
    files = flattenTree(commitTree(commit));
    parents = [commit];
  }
  const existing = files.get(path);
  if (existing !== undefined && input.sha !== undefined && input.sha !== existing.oid) {
    return { status: 409, blobSha: existing.oid, commitSha: '' };
  }
  const blobSha = storeObject('blob', input.content);
  files.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  const tree = buildTreeFromFlat(files);
  const line = forgeAuthorLine();
  const commitSha = storeCommit({
    tree,
    parents,
    author: line,
    committer: line,
    message: `${input.message}\n`,
  });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  return { status: existing !== undefined ? 200 : 201, blobSha, commitSha };
}

/** Delete one file on the default (or named) branch; false when the file or branch is missing. */
export function deleteContents(
  repo: RepoRec,
  input: { path: string; message: string; branch?: string; sha?: string },
): { commitSha: string } | null {
  const branch = input.branch !== undefined && input.branch !== '' ? input.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) return null;
  const commit = peelToCommit(tip);
  const files = flattenTree(commitTree(commit));
  const path = input.path.replace(/^\/+/, '');
  if (!files.has(path)) return null;
  files.delete(path);
  const tree = buildTreeFromFlat(files);
  const line = forgeAuthorLine();
  const commitSha = storeCommit({
    tree,
    parents: [commit],
    author: line,
    committer: line,
    message: `${input.message}\n`,
  });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  return { commitSha };
}

/** Resolve a `ref` query value (branch name, full ref, or commit oid) to a commit oid. */
export function resolveRef(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = branchTip(repo, repo.defaultBranch);
    return tip === undefined ? null : peelToCommit(tip);
  }
  const asBranch = branchTip(repo, ref);
  if (asBranch !== undefined) return peelToCommit(asBranch);
  const asRef = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
  if (asRef !== undefined) return peelToCommit(asRef);
  const obj = getObject(ref);
  if (obj !== undefined && (obj.type === 'commit' || obj.type === 'tag')) return peelToCommit(ref);
  return null;
}

/** Commits reachable from a commit, newest first (committer time, then discovery order). */
export function listCommits(startCommit: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [startCommit];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    order.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  const timeOf = (oid: string): number => {
    const obj = getObject(oid);
    return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).time : 0;
  };
  return order
    .map((oid, index) => ({ oid, index, time: timeOf(oid) }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((entry) => entry.oid);
}

/** First-parent ancestry test used by receive-pack's fast-forward rule. */
export function refUpdateAllowed(oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  return isAncestor(oldOid, peelToCommit(newOid));
}

export { lookupPath, parseTree };
