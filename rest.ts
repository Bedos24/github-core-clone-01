// The REST v3 surface: the API root, meta, the viewer, repositories, git refs, branches,
// commits, the contents API, labels, issues with comments, and pull requests with merge.
// Every answer is JSON with a string `message` on errors; the exact statuses (201 creates,
// 204 delete, 409 stale contents sha, 405 unmergeable pull, 422 validation) are the checks'.

import { getObject, parseCommit } from './gitobj.ts';
import {
  Forge,
  VIEWER,
  branchTip,
  commentJson,
  commitTree,
  createIssue,
  createPull,
  deleteContents,
  diffTrees,
  fullName,
  globalId,
  issueJson,
  listCommits,
  lookupPath,
  mergePull,
  parseTree,
  pullJson,
  repoJson,
  resolveRef,
  writeContents,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { authed, intParam, readJsonBody, sendError, sendJson, type Ctx } from './http.ts';

const SCOPES = 'repo, read:org';

export async function handleRest(forge: Forge, ctx: Ctx): Promise<void> {
  ctx.res.setHeader('x-oauth-scopes', SCOPES);
  if (!authed(ctx)) {
    sendError(ctx, 401, 'Bad credentials');
    return;
  }
  const seg = ctx.segments.slice(2);
  const method = ctx.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        rate_limit_url: '/api/v3/rate_limit',
      });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, { installed_version: '1.0.0-makefun-forge', github_hostname: 'forge.local' });
    return;
  }

  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('User', String(VIEWER.id)),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
    });
    return;
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      listUserRepos(forge, ctx);
      return;
    }
    if (method === 'POST') {
      await createRepo(forge, ctx);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = forge.getRepo(seg[1]!, seg[2]!);
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    await handleRepo(forge, ctx, repo, seg.slice(3));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function listUserRepos(forge: Forge, ctx: Ctx): void {
  const perPage = intParam(ctx, 'per_page', 30);
  const page = intParam(ctx, 'page', 1);
  const all = forge.listRepos();
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const next = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(ctx, 200, slice.map(repoJson), headers);
}

async function createRepo(forge: Forge, ctx: Ctx): Promise<void> {
  const body = await readJsonBody(ctx);
  if (!body.ok) return;
  const name = typeof body.value.name === 'string' ? body.value.name : '';
  if (name === '' || name.includes('/') || name === '.' || name === '..') {
    sendError(ctx, 422, 'Validation Failed: name is invalid');
    return;
  }
  if (forge.getRepoByName(name) !== undefined) {
    sendError(ctx, 422, 'Validation Failed: name already exists on this account');
    return;
  }
  const repo = forge.createRepo({
    name,
    description: typeof body.value.description === 'string' ? body.value.description : '',
    isPrivate: body.value.private === true,
    defaultBranch: typeof body.value.default_branch === 'string' ? body.value.default_branch : undefined,
  });
  sendJson(ctx, 201, repoJson(repo));
}

async function handleRepo(forge: Forge, ctx: Ctx, repo: RepoRec, seg: string[]): Promise<void> {
  const method = ctx.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(ctx);
      if (!body.ok) return;
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
      if (typeof body.value.default_branch === 'string' && body.value.default_branch !== '') repo.defaultBranch = body.value.default_branch;
      repo.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      sendJson(ctx, 204, undefined);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'git' && seg[1] === 'refs') {
    await handleRefs(ctx, repo, seg.slice(2));
    return;
  }

  if (seg[0] === 'branches') {
    handleBranches(ctx, repo, seg.slice(1));
    return;
  }

  if (seg[0] === 'commits' && seg.length === 1 && method === 'GET') {
    handleCommits(ctx, repo);
    return;
  }

  if (seg[0] === 'contents') {
    await handleContents(ctx, repo, seg.slice(1).join('/'));
    return;
  }

  if (seg[0] === 'labels' && seg.length === 1) {
    await handleLabels(ctx, repo);
    return;
  }

  if (seg[0] === 'issues') {
    await handleIssues(forge, ctx, repo, seg.slice(1));
    return;
  }

  if (seg[0] === 'pulls') {
    await handlePulls(forge, ctx, repo, seg.slice(1));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- refs and branches

async function handleRefs(ctx: Ctx, repo: RepoRec, seg: string[]): Promise<void> {
  const method = ctx.method;
  if (seg.length === 0 && method === 'POST') {
    const body = await readJsonBody(ctx);
    if (!body.ok) return;
    const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
    const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
    if (!ref.startsWith('refs/') || getObject(sha) === undefined) {
      sendError(ctx, 422, 'Validation Failed: ref or sha is invalid');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(ctx, 422, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(ctx, 201, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), object: { sha, type: getObject(sha)!.type } });
    return;
  }
  if (seg.length === 0 && method === 'GET') {
    const all = [...repo.refs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } }));
    sendJson(ctx, 200, all);
    return;
  }
  if (seg.length >= 1 && method === 'GET') {
    const ref = `refs/${seg.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), object: { sha, type: getObject(sha)?.type ?? 'commit' } });
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function handleBranches(ctx: Ctx, repo: RepoRec, seg: string[]): void {
  if (ctx.method !== 'GET') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (seg.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(ctx, 200, branches);
    return;
  }
  const name = seg.join('/');
  const sha = branchTip(repo, name);
  if (sha === undefined) {
    sendError(ctx, 404, 'Branch not found');
    return;
  }
  sendJson(ctx, 200, { name, commit: { sha }, protected: false });
}

// ---------------------------------------------------------------- commits

function authorJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: '', email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function handleCommits(ctx: Ctx, repo: RepoRec): void {
  const shaParam = ctx.query.get('sha') ?? undefined;
  const start = resolveRef(repo, shaParam);
  if (start === null) {
    if (shaParam === undefined) sendError(ctx, 409, 'Git Repository is empty.');
    else sendError(ctx, 404, 'Not Found');
    return;
  }
  const perPage = intParam(ctx, 'per_page', 30);
  const page = intParam(ctx, 'page', 1);
  const all = listCommits(start);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  sendJson(
    ctx,
    200,
    slice.map((oid) => {
      const info = parseCommit(getObject(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: info.message.replace(/\n$/, ''),
          author: authorJson(info.authorLine),
          committer: authorJson(info.committerLine),
          tree: { sha: info.tree },
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
      };
    }),
  );
}

// ---------------------------------------------------------------- contents

async function handleContents(ctx: Ctx, repo: RepoRec, path: string): Promise<void> {
  const method = ctx.method;
  if (method === 'GET') {
    const commit = resolveRef(repo, ctx.query.get('ref') ?? undefined);
    if (commit === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const tree = commitTree(commit);
    if (path === '') {
      sendDirListing(ctx, tree, '');
      return;
    }
    const entry = lookupPath(tree, path);
    if (entry === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (entry.mode === '40000') {
      sendDirListing(ctx, entry.oid, path);
      return;
    }
    const blob = getObject(entry.oid);
    if (blob === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      content: blob.data.toString('base64'),
    });
    return;
  }

  if (method === 'PUT') {
    const body = await readJsonBody(ctx);
    if (!body.ok) return;
    const contentB64 = typeof body.value.content === 'string' ? body.value.content.replace(/\s/g, '') : '';
    const result = writeContents(repo, {
      path,
      content: Buffer.from(contentB64, 'base64'),
      message: typeof body.value.message === 'string' ? body.value.message : '',
      branch: typeof body.value.branch === 'string' ? body.value.branch : undefined,
      sha: typeof body.value.sha === 'string' ? body.value.sha : undefined,
    });
    if (result === null) {
      sendError(ctx, 422, 'Validation Failed: path is invalid');
      return;
    }
    if (result.status === 409) {
      sendError(ctx, 409, `${path} does not match the given sha`);
      return;
    }
    const blob = getObject(result.blobSha);
    sendJson(ctx, result.status, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: blob?.data.length ?? 0,
        name: path.split('/').pop(),
        path,
        sha: result.blobSha,
      },
      commit: { sha: result.commitSha },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(ctx);
    if (!body.ok) return;
    const result = deleteContents(repo, {
      path,
      message: typeof body.value.message === 'string' ? body.value.message : '',
      branch: typeof body.value.branch === 'string' ? body.value.branch : undefined,
      sha: typeof body.value.sha === 'string' ? body.value.sha : undefined,
    });
    if (result === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { content: null, commit: { sha: result.commitSha } });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function sendDirListing(ctx: Ctx, treeOid: string, basePath: string): void {
  const obj = getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const entries = parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (getObject(entry.oid)?.data.length ?? 0),
  }));
  sendJson(ctx, 200, entries);
}

// ---------------------------------------------------------------- labels

async function handleLabels(ctx: Ctx, repo: RepoRec): Promise<void> {
  if (ctx.method === 'GET') {
    sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false, description: null })));
    return;
  }
  if (ctx.method === 'POST') {
    const body = await readJsonBody(ctx);
    if (!body.ok) return;
    const name = typeof body.value.name === 'string' ? body.value.name : '';
    if (name === '') {
      sendError(ctx, 422, 'Validation Failed: name is required');
      return;
    }
    if (repo.labels.has(name.toLowerCase())) {
      sendError(ctx, 422, 'Validation Failed: name has already been taken');
      return;
    }
    const color = typeof body.value.color === 'string' ? body.value.color.replace(/^#/, '') : '000000';
    repo.labels.set(name.toLowerCase(), { name, color });
    sendJson(ctx, 201, { name, color, default: false, description: null });
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- issues

async function handleIssues(forge: Forge, ctx: Ctx, repo: RepoRec, seg: string[]): Promise<void> {
  const method = ctx.method;

  if (seg.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(ctx);
      if (!body.ok) return;
      const title = typeof body.value.title === 'string' ? body.value.title : '';
      if (title === '') {
        sendError(ctx, 422, 'Validation Failed: title is required');
        return;
      }
      const requested = Array.isArray(body.value.labels) ? body.value.labels.filter((x): x is string => typeof x === 'string') : [];
      const labels: string[] = [];
      for (const name of requested) {
        const found = repo.labels.get(name.toLowerCase());
        if (found === undefined) {
          sendError(ctx, 422, `Validation Failed: label '${name}' does not exist`);
          return;
        }
        labels.push(found.name);
      }
      const issue = createIssue(forge, repo, {
        title,
        body: typeof body.value.body === 'string' ? body.value.body : '',
        labels,
      });
      sendJson(ctx, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      const perPage = intParam(ctx, 'per_page', 30);
      const page = intParam(ctx, 'page', 1);
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = issues.slice((page - 1) * perPage, page * perPage);
      sendJson(ctx, 200, slice.map((issue) => issueJson(repo, issue)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(seg[0]!, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;

  if (seg.length === 1) {
    if (issue === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(ctx);
      if (!body.ok) return;
      if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
      if (typeof body.value.title === 'string' && body.value.title !== '') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      issue.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg.length === 2 && seg[1] === 'comments') {
    const holder = issue ?? pull;
    if (holder === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, holder.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx);
      if (!body.ok) return;
      const text = typeof body.value.body === 'string' ? body.value.body : '';
      if (text === '') {
        sendError(ctx, 422, 'Validation Failed: body is required');
        return;
      }
      const comment = { id: forge.allocCommentId(), body: text, createdAt: new Date().toISOString() };
      holder.comments.push(comment);
      sendJson(ctx, 201, commentJson(comment));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

async function handlePulls(forge: Forge, ctx: Ctx, repo: RepoRec, seg: string[]): Promise<void> {
  const method = ctx.method;

  if (seg.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(ctx);
      if (!body.ok) return;
      const title = typeof body.value.title === 'string' ? body.value.title : '';
      const head = stripOwnerPrefix(typeof body.value.head === 'string' ? body.value.head : '');
      const base = stripOwnerPrefix(typeof body.value.base === 'string' ? body.value.base : '');
      if (title === '' || head === '' || base === '') {
        sendError(ctx, 422, 'Validation Failed: title, head and base are required');
        return;
      }
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        sendError(ctx, 422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate !== undefined) {
        sendError(ctx, 422, `A pull request already exists for ${repo.owner}:${head}.`);
        return;
      }
      const pull = createPull(forge, repo, {
        title,
        body: typeof body.value.body === 'string' ? body.value.body : '',
        head,
        base,
      });
      if (pull === null) {
        sendError(ctx, 422, 'Validation Failed');
        return;
      }
      sendJson(ctx, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      sendJson(ctx, 200, pulls.map((pull) => pullJson(repo, pull)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(seg[0]!, 10);
  const pull: PullRec | undefined = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, pullJson(repo, pull));
    return;
  }

  if (seg.length === 2 && seg[1] === 'files' && method === 'GET') {
    const files = diffTrees(pull.baseSha, pull.headSha).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    sendJson(ctx, 200, files);
    return;
  }

  if (seg.length === 2 && seg[1] === 'merge' && method === 'PUT') {
    const body = await readJsonBody(ctx);
    if (!body.ok) return;
    if (pull.merged || pull.state !== 'open') {
      sendError(ctx, 405, 'Pull Request is not mergeable');
      return;
    }
    const methodWanted = body.value.merge_method === 'merge' ? 'merge' : 'squash';
    const sha = mergePull(repo, pull, methodWanted);
    if (sha === null) {
      sendError(ctx, 405, 'Pull Request is not mergeable');
      return;
    }
    sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

export { fullName };
