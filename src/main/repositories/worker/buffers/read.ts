import path from 'path';
import fs from 'fs-extra';
import git from 'isomorphic-git';
import { BufferDataset } from '@riboseinc/paneron-extension-kit/types/buffers';
import { stripLeadingSlash } from 'utils';
import { listDescendantPaths } from './list';


/* Given a root path, returns a BufferDataset containing data under that path.
   Paths in buffer dataset will be slash-prepended and relative to root path. */
export async function readBuffers(
  rootPath: string,
): Promise<Record<string, Uint8Array>> {
  const buffers: Record<string, Uint8Array> = {};
  for await (const relativeBufferPath of listDescendantPaths(rootPath)) {
    const bufferData = await readBuffer(path.join(rootPath, relativeBufferPath));
    if (bufferData) {
      buffers[relativeBufferPath] = bufferData;
    }
  }
  return buffers;
}


/* Reads buffer data for specified paths, optionally at specified Git commit. */
export async function readBuffers2(
  workDir: string,
  bufferPaths: string[],
  atCommitHash?: string,
): Promise<BufferDataset> {
  const normalizedPaths = bufferPaths.map(stripLeadingSlash);

  let reader: (path: string) => Promise<null | Uint8Array>;
  if (atCommitHash === undefined) {
    reader = (p) => readBuffer(path.join(workDir, p));
  } else {
    reader = (p) => readBufferAtVersion(p, atCommitHash, workDir);
  }

  return (await Promise.all(normalizedPaths.map(async ([path]) => {
    return {
      [path]: await reader(path),
    };
  }))).reduce((prev, curr) => ({ ...prev, ...curr }), {});
}


/* Returns blob at given path, or null if it doesn’t exist.
   Blob may have uncommitted changes.

   Buffer is considered nonexistent if ENOENT is received,
   other errors are thrown. */
export async function readBuffer(fullPath: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(fullPath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null;
    } else {
      throw e;
    }
  }
}


/* Retrieves state of blob at given path as of given commit hash using Git.

   Buffer is considered nonexistent if Isomorphic Git returns NotFoundError,
   other errors are thrown.

   NOTE: This function is somewhat slow. */
export async function readBufferAtVersion(
  path: string,
  commitHash: string,
  workDir: string,
): Promise<Uint8Array | null> {
  let blob: Uint8Array;
  try {
    blob = (await git.readBlob({
      fs,
      dir: workDir,
      oid: commitHash,
      filepath: path,
    })).blob;
  } catch (e) {
    if (e.code === 'NotFoundError') {
      return null;
    } else {
      throw e;
    }
  }
  return blob;
}