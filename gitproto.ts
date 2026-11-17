// Git smart HTTP: info/refs advertisements (v0 and v2), ls-refs, fetch (protocol v2 with
// haves, shallow and deepen; v0 fallback) and receive-pack with report-status. Objects are
// served from and stored into the shared content-addressed store, so a push is visible to
// REST, GraphQL and MCP the moment it lands.

import {
  ZERO_OID,
  getObject,
  objectClosure,
  parseCommit,
  parseTree,
  peelOne,
  peelToCommit,
  reachableCommits,
  readPackIntoStore,
  writePack,
} from './gitobj.ts';
import { Forge, refUpdateAllowed, type RepoRec } from './store.ts';
import { authed, readBody, sendBytes, sendError, type Ctx } from './http.ts';

const AGENT = 'makefun-forge/1.0.0';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse pkt-lines from `body` starting at `start`; returns packets and the offset after the last one. */
export function parsePackets(body: Buffer, start = 0): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= body.length) {
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length at ${offset}`);
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line overruns body');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

function lineText(payload: Buffer): string {
  return payload.toString('utf8').replace(/\n$/, '');
}

/** Split a v2 command request into the lines before and after the delim packet. */
function splitCommand(packets: Packet[]): { head: string[]; args: string[] } {
  const head: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    (inArgs ? args : head).push(lineText(packet.payload));
  }
  return { head, args };
}

// ---------------------------------------------------------------- routing

export async function handleGit(forge: Forge, ctx: Ctx): Promise<void> {
  if (!authed(ctx)) {
    sendError(ctx, 401, 'Bad credentials');
    return;
  }
  const [owner, repoGit, ...rest] = ctx.segments;
  const repo = repoGit !== undefined && repoGit.endsWith('.git') ? forge.getRepo(owner!, repoGit.slice(0, -4)) : undefined;
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const tail = rest.join('/');

  if (ctx.method === 'GET' && tail === 'info/refs') {
    handleInfoRefs(ctx, repo);
    return;
  }
  if (ctx.method === 'POST' && tail === 'git-upload-pack') {
    await handleUploadPack(ctx, repo);
    return;
  }
  if (ctx.method === 'POST' && tail === 'git-receive-pack') {
    await handleReceivePack(ctx, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function handleInfoRefs(ctx: Ctx, repo: RepoRec): void {
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 400, 'Unknown service');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];

  if (wantsV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
    return;
  }

  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not object-format=sha1 agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=${AGENT}`;
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const headOid = repo.refs.get(defaultRef);
    if (headOid !== undefined) lines.push(`${headOid} HEAD`);
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}`);
      const peeled = peelOne(oid);
      if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
    }
  }
  lines.forEach((line, index) => {
    let text = `${line}\n`;
    if (index === 0) {
      const symref = repo.refs.has(defaultRef) ? ` symref=HEAD:${defaultRef}` : '';
      text = `${line}\0${caps}${service === 'git-upload-pack' ? symref : ''}\n`;
    }
    parts.push(pktLine(text));
  });
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------- upload-pack

async function handleUploadPack(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = await readBody(ctx.req);
  try {
    const { packets } = parsePackets(body);
    const firstData = packets.find((packet) => packet.kind === 'data');
    const firstLine = firstData === undefined ? '' : lineText(firstData.payload);
    const isV2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
    if (isV2 && firstLine.startsWith('command=ls-refs')) {
      handleLsRefs(ctx, repo, packets);
      return;
    }
    if (isV2 && firstLine.startsWith('command=fetch')) {
      handleFetchV2(ctx, repo, packets);
      return;
    }
    if (firstLine.startsWith('want ') || packets.some((packet) => packet.kind === 'data' && lineText(packet.payload).startsWith('want '))) {
      handleFetchV0(ctx, repo, body);
      return;
    }
    sendError(ctx, 400, 'Unsupported upload-pack request');
  } catch {
    // A malformed body must never take the server down (the suite probes exactly that).
    if (!ctx.res.headersSent) sendError(ctx, 400, 'Bad request');
  }
}

function refMatchesPrefixes(ref: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => ref.startsWith(prefix) || prefix.startsWith(ref));
}

function handleLsRefs(ctx: Ctx, repo: RepoRec, packets: Packet[]): void {
  const { args } = splitCommand(packets);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
  }
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const headWanted = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (headWanted) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!refMatchesPrefixes(ref, prefixes)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelOne(oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- fetch

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** Decide the object set a fetch delivers, plus the shallow boundary after it. */
function planFetch(repo: RepoRec, plan: FetchPlan): { objects: string[]; boundary: string[]; unshallow: string[] } {
  const clientShallow = new Set(plan.shallow);
  const haveClosure = objectClosure(plan.haves, clientShallow);
  const haveCommits = new Set([...haveClosure].filter((oid) => getObject(oid)?.type === 'commit'));

  const excluded = new Set<string>();
  for (const ref of plan.deepenNot) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) for (const commit of reachableCommits([peelToCommit(oid)])) excluded.add(commit);
  }

  const wantCommits = plan.wants.map((oid) => peelToCommit(oid));
  const sendCommits = new Set<string>();
  if (plan.deepen !== null) {
    // Generation-limited walk: the want is generation 1, its parents 2, and so on.
    const generation = new Map<string, number>();
    const queue: string[] = [];
    for (const commit of wantCommits) {
      generation.set(commit, 1);
      queue.push(commit);
    }
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const gen = generation.get(oid)!;
      if (gen > plan.deepen) continue;
      if (!excluded.has(oid)) sendCommits.add(oid);
      if (gen === plan.deepen) continue;
      const obj = getObject(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseParents(obj.data)) {
        if (!generation.has(parent)) {
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
  } else if (plan.deepenSince !== null) {
    for (const commit of reachableCommits(wantCommits)) {
      const obj = getObject(commit);
      if (obj === undefined) continue;
      if (commitTime(obj.data) > plan.deepenSince && !excluded.has(commit)) sendCommits.add(commit);
    }
  } else {
    for (const commit of reachableCommits(wantCommits)) {
      if (!excluded.has(commit)) sendCommits.add(commit);
    }
  }
  for (const commit of [...sendCommits]) {
    if (haveCommits.has(commit)) sendCommits.delete(commit);
  }

  // The boundary: delivered commits with a parent the client will not hold after this fetch.
  const heldAfter = new Set<string>([...haveCommits, ...sendCommits]);
  const boundary: string[] = [];
  for (const commit of sendCommits) {
    const obj = getObject(commit);
    if (obj === undefined) continue;
    const parents = parseParents(obj.data);
    if (parents.some((parent) => !heldAfter.has(parent))) boundary.push(commit);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (boundary.includes(oid)) continue;
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseParents(obj.data);
    if (parents.length > 0 && parents.every((parent) => heldAfter.has(parent))) unshallow.push(oid);
  }

  const objects = new Set<string>();
  for (const oid of plan.wants) {
    if (getObject(oid)?.type === 'tag') objects.add(oid);
  }
  for (const commit of sendCommits) {
    objects.add(commit);
    const obj = getObject(commit);
    if (obj !== undefined) addTreeObjects(parseCommit(obj.data).tree, objects);
  }
  for (const oid of haveClosure) objects.delete(oid);
  const ordered = [...objects].sort((a, b) => {
    const rank = (oid: string): number => {
      const type = getObject(oid)?.type;
      return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3;
    };
    return rank(a) - rank(b);
  });
  return { objects: ordered, boundary, unshallow };
}

/** Add a tree and everything under it (subtrees and blobs) to a set — never parent commits. */
function addTreeObjects(treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeObjects(entry.oid, into);
    else into.add(entry.oid);
  }
}

function parseParents(commitData: Buffer): string[] {
  const text = commitData.toString('utf8');
  const parents: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    if (line === '') break;
  }
  return parents;
}

function commitTime(commitData: Buffer): number {
  const match = /^committer .* (\d+) [+-]\d{4}$/m.exec(commitData.toString('utf8'));
  return match === null ? 0 : Number(match[1]);
}

/** Frame a pack as sideband-1 packets, each within the 65520-byte pkt-line limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

function handleFetchV2(ctx: Ctx, repo: RepoRec, packets: Packet[]): void {
  const { args } = splitCommand(packets);
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5, 45));
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5, 45));
    else if (arg.startsWith('shallow ')) plan.shallow.push(arg.slice(8, 48));
    else if (arg.startsWith('deepen ')) plan.deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('deepen-since ')) plan.deepenSince = Number.parseInt(arg.slice(13), 10);
    else if (arg.startsWith('deepen-not ')) plan.deepenNot.push(arg.slice(11));
    else if (arg.startsWith('want-ref ')) {
      const oid = repo.refs.get(arg.slice(9));
      if (oid !== undefined) plan.wants.push(oid);
    }
  }
  for (const oid of [...plan.wants, ...plan.haves]) {
    if (getObject(oid) === undefined) throw new Error(`unknown object ${oid}`);
  }
  const { objects, boundary, unshallow } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.deepen !== null || plan.deepenSince !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(objects)));
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(ctx: Ctx, repo: RepoRec, body: Buffer): void {
  // Two pkt-line sections: wants (the first carries the capabilities after a NUL), a flush,
  // then haves and a literal `done` line, a flush.
  const first = parsePackets(body);
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  let caps = '';
  let sawFlush = false;
  let offset = 0;
  // Re-walk manually: parsePackets stops at the first flush, which is exactly the section split.
  for (const packet of first.packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = lineText(packet.payload);
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (text.startsWith('want ')) plan.wants.push(text.slice(5, 45));
  }
  offset = first.offset;
  if (sawFlush && offset < body.length) {
    const second = parsePackets(body, offset);
    for (const packet of second.packets) {
      if (packet.kind !== 'data') continue;
      const text = lineText(packet.payload);
      if (text.startsWith('have ')) plan.haves.push(text.slice(5, 45));
      else if (text.startsWith('shallow ')) plan.shallow.push(text.slice(8, 48));
      else if (text.startsWith('deepen ')) plan.deepen = Number.parseInt(text.slice(7), 10);
    }
  }
  const { objects, boundary } = planFetch(repo, plan);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (caps.split(' ').includes('side-band-64k') || caps.split(' ').includes('side-band')) {
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pack);
  }
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = await readBody(ctx.req);
  try {
    const { packets, offset } = parsePackets(body);
    const commands: PushCommand[] = [];
    let caps = '';
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let text = lineText(packet.payload);
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
      const parts = text.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    const packBytes = body.subarray(offset);
    let unpackError: string | null = null;
    if (packBytes.length > 0) {
      try {
        readPackIntoStore(packBytes);
      } catch (error) {
        unpackError = error instanceof Error ? error.message : String(error);
      }
    }

    const capSet = new Set(caps.split(' ').filter((cap) => cap !== ''));
    const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
        continue;
      }
      if (unpackError !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
        continue;
      }
      if (getObject(command.newOid) === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'new object not found' });
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.oldOid !== ZERO_OID && current !== undefined && current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && current !== undefined && !refUpdateAllowed(current, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
    }
    repo.updatedAt = new Date().toISOString();

    if (!capSet.has('report-status') && !capSet.has('report-status-v2')) {
      sendBytes(ctx, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
      return;
    }
    const lines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
    for (const result of results) {
      lines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'rejected'}`);
    }
    const parts: Buffer[] = [];
    if (capSet.has('side-band-64k')) {
      for (const line of lines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
      parts.push(PKT_FLUSH);
    } else {
      for (const line of lines) parts.push(pktLine(`${line}\n`));
      parts.push(PKT_FLUSH);
    }
    sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  } catch {
    if (!ctx.res.headersSent) sendError(ctx, 400, 'Bad request');
  }
}
