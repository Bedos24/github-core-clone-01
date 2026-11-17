// Git object model: content-addressed store, tree/commit/tag build+parse, pack read/write,
// reachability. Pure Node built-ins; objects live in one process-wide map (a forge trial is one
// process, and content addressing makes cross-repo sharing safe).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

/** Every object this process knows, by sha1. */
export const objectStore = new Map<string, StoredObject>();

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object and return its id. Idempotent. */
export function storeObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objectStore.has(oid)) objectStore.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): StoredObject | undefined {
  return objectStore.get(oid);
}

export function isCommit(oid: string): boolean {
  return objectStore.get(oid)?.type === 'commit';
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** Octal mode as written in the tree: '100644', '100755', '120000', '40000' for directories. */
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree order: byte-wise by name, directories compared as if the name ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeTree(entries: readonly TreeEntry[]): string {
  return storeObject('tree', serializeTree(entries));
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Flatten a tree (recursively) into path -> {oid, mode} for files (blobs) only. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> {oid, mode} map; returns the root tree oid. */
export function buildTreeFromFlat(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]!);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i]!, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    return storeTree(entries);
  };
  return emit(root);
}

/** Walk a tree to one path; returns the entry or undefined. */
export function lookupPath(treeOid: string, path: string): TreeEntry | undefined {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return undefined;
    if (i === parts.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  /** Author timestamp (unix seconds), 0 when unparseable. */
  time: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committerLine);
  return { tree, parents, authorLine, committerLine, time: timeMatch ? Number(timeMatch[1]) : 0, message };
}

export function buildCommitData(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export function storeCommit(input: Parameters<typeof buildCommitData>[0]): string {
  return storeObject('commit', buildCommitData(input));
}

/** The commit a tag object points at (following nested tags); the oid itself when it is a commit. */
export function peelToCommit(oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = getObject(current);
    if (obj === undefined) return current;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return current;
    current = match[1]!;
  }
  return current;
}

/** The object a tag directly names (one peel), for ls-refs `peeled:` attributes. */
export function peelOne(oid: string): string | null {
  const obj = getObject(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1]!;
}

// ---------------------------------------------------------------- reachability

/** All commits reachable from `tips` (inclusive), following parents. */
export function reachableCommits(tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = peelOne(oid);
      if (target !== null) stack.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (both commits). */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits([descendant]).has(ancestor);
}

/** A merge base of two commits: the common ancestor with the greatest commit time. */
export function mergeBase(a: string, b: string): string | null {
  const fromA = reachableCommits([a]);
  const seen = new Set<string>();
  const queue = [b];
  let best: string | null = null;
  let bestTime = -1;
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (fromA.has(oid) && info.time >= bestTime) {
      best = oid;
      bestTime = info.time;
    }
    for (const parent of info.parents) queue.push(parent);
  }
  return best;
}

/**
 * The full object closure from tips: commits (following parents), their trees recursively and
 * blobs, and tag objects. When `stopCommits` is given, those commits are included but their
 * parents are not followed (a shallow client's boundary).
 */
export function objectClosure(tips: readonly string[], stopCommits?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  const addTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    const obj = getObject(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      out.add(oid);
      const target = peelOne(oid);
      if (target !== null) stack.push(target);
      continue;
    }
    if (obj.type !== 'commit') {
      out.add(oid);
      continue;
    }
    out.add(oid);
    const info = parseCommit(obj.data);
    addTree(info.tree);
    if (stopCommits !== undefined && stopCommits.has(oid)) continue;
    for (const parent of info.parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- packs

function encodePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain (undeltified) objects, with the sha1 trailer. */
export function writePack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(oid);
    if (obj === undefined) continue;
    parts.push(encodePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert program) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset]!; offset += 1; }
      if (op & 0x02) { copyOffset += delta[offset]! * 256; offset += 1; }
      if (op & 0x04) { copyOffset += delta[offset]! * 65536; offset += 1; }
      if (op & 0x08) { copyOffset += delta[offset]! * 16777216; offset += 1; }
      if (op & 0x10) { copySize = delta[offset]!; offset += 1; }
      if (op & 0x20) { copySize += delta[offset]! * 256; offset += 1; }
      if (op & 0x40) { copySize += delta[offset]! * 65536; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      chunks.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(chunks);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

interface PendingDelta {
  kind: 'ofs' | 'ref';
  /** Pack offset of the base (ofs) or base oid (ref). */
  baseKey: number | string;
  /** This delta object's own pack offset, so chained OFS deltas can find its result. */
  selfOffset: number;
  delta: Buffer;
}

/**
 * Read a pack (v2/v3), store every object, and return the stored oids. Resolves OFS_DELTA and
 * REF_DELTA (bases in a well-formed pack precede their deltas; out-of-pack REF bases resolve
 * against the store, which is what makes thin packs work). Throws on malformed input; callers
 * turn that into `unpack <error>`.
 */
export function readPackIntoStore(pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  let offset = 12;
  const stored: string[] = [];
  const byPackOffset = new Map<number, string>();
  const pending: PendingDelta[] = [];

  const tryResolvePending = (): void => {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const item = pending[i]!;
        const baseOid = item.kind === 'ofs' ? byPackOffset.get(item.baseKey as number) : (item.baseKey as string);
        if (baseOid === undefined) continue;
        const base = getObject(baseOid);
        if (base === undefined) continue;
        const resultOid = storeObject(base.type, applyDelta(base.data, item.delta));
        byPackOffset.set(item.selfOffset, resultOid);
        stored.push(resultOid);
        pending.splice(i, 1);
        progress = true;
      }
    }
  };

  for (let index = 0; index < count; index += 1) {
    const objectOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseKey: number | string | null = null;
    let kind: 'ofs' | 'ref' | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: negative-offset varint naming the base object's pack offset.
      let backByte = pack[offset]!;
      offset += 1;
      let back = backByte & 0x7f;
      while (backByte & 0x80) {
        backByte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (backByte & 0x7f);
      }
      kind = 'ofs';
      baseKey = objectOffset - back;
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id follows the header.
      kind = 'ref';
      baseKey = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset));
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    offset += compressedLength(pack, offset, size);
    if (kind !== null) {
      const baseOid = kind === 'ofs' ? byPackOffset.get(baseKey as number) : (baseKey as string);
      const base = baseOid === undefined ? undefined : getObject(baseOid);
      if (base !== undefined) {
        const resultOid = storeObject(base.type, applyDelta(base.data, inflated));
        byPackOffset.set(objectOffset, resultOid);
        stored.push(resultOid);
      } else pending.push({ kind, baseKey: baseKey!, selfOffset: objectOffset, delta: inflated });
      continue;
    }
    const type = CODE_TO_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const oid = storeObject(type, inflated);
    byPackOffset.set(objectOffset, oid);
    stored.push(oid);
    tryResolvePending();
  }
  tryResolvePending();
  if (pending.length > 0) throw new Error('pack has unresolvable deltas');
  return stored;
}

/**
 * How many compressed bytes the zlib stream at `offset` occupies. inflateSync ignores trailing
 * bytes and throws on a truncated stream, so the consumed length is the shortest prefix that
 * inflates to exactly `expectedPlain` bytes — found by binary search.
 */
function compressedLength(pack: Buffer, offset: number, expectedPlain: number): number {
  let lo = 1;
  let hi = pack.length - offset;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let ok = false;
    try {
      ok = inflateSync(pack.subarray(offset, offset + mid)).length === expectedPlain;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
