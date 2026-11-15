import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// A bot's folder is its agent's working folder, so the agent can put links in
// it: memory/log -> ~/.zshrc, skills -> /usr/local/bin. Every write, append and
// delete the plugin makes inside a bot's folder goes through these, which won't
// pass through a link. A link swapped in between the check and the write is a
// race between programs, outside what these guard against.

/** Windows has no O_NOFOLLOW; the link check before it still runs. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Throws when `path`, or a folder between `root` (included) and it, is a link. Parts that don't exist yet are fine. */
export async function refuseLinks(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} isn't inside ${root}.`);
  let current = root;
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`paseo-bots won't follow the link at ${current}.`);
  }
}

/** Writes a file under `root`, refusing a link; it writes a new file and renames it over the old one, so a hard link is replaced, never written through. */
export async function writeInside(root: string, path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await refuseLinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    await file.writeFile(data);
  } finally {
    await file.close();
  }
  await rename(temp, path).catch(async (error: unknown) => {
    await rm(temp, { force: true });
    throw error;
  });
}

/** Appends to a file under `root`; refuses a link, and a hard link to a file elsewhere. */
export async function appendInside(root: string, path: string, text: string, mode?: number): Promise<void> {
  await refuseLinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, mode);
  try {
    if ((await file.stat()).nlink > 1) throw new Error(`paseo-bots won't append to ${path}: it's linked to another file.`);
    await file.appendFile(text, "utf8");
  } finally {
    await file.close();
  }
}

/** Deletes a file under `root`. A link in its place is removed itself; a link on the way there is refused. */
export async function removeInside(root: string, path: string): Promise<void> {
  await refuseLinks(root, dirname(path));
  await rm(path, { force: true });
}
