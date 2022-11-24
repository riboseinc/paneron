import type { Changeset, PathChanges } from '@riboseinc/paneron-extension-kit/types/changes';
import crypto from 'crypto';

export function changesetToPathChanges(
  changeset: Changeset<any>,
): PathChanges {
  const changes: PathChanges = {};
  for (const [path, change] of Object.entries(changeset)) {
    if (change.newValue === null && change.oldValue === null) {
      throw new Error("Encountered a non-change in a changeset");
    } else if (change.newValue === null && change.oldValue !== null) {
      changes[path] = 'removed';
    } else if (change.newValue !== null && change.oldValue === null) {
      changes[path] = 'added';
    } else if (change.newValue !== change.oldValue) {
      changes[path] = 'modified';
    }
  }
  return changes;
}

// function changedPathsToPathChanges(
//   changedPaths: [path: string, change: ChangeStatus][]
// ): PathChanges {
//   const pathChanges: PathChanges = changedPaths.
//     map(([path, change]) => ({ [path]: change })).
//     reduce((prev, curr) => ({ ...prev, ...curr }));
//   return pathChanges;
// }


export function forceSlug(val: string): string {
  return val.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
}


export function stripLeadingSlash(aPath: string): string {
  return aPath.replace(/^\//, '');
}


export function stripTrailingSlash(aPath: string): string {
  return aPath.replace(/\/$/, '');
}


export function hash(val: string): string {
  return crypto.createHash('sha1').update(val).digest('hex');
}


export function toJSONPreservingUndefined(data: any) {
  return (JSON.
    stringify(
      data || {},
      (_, v) => (v === undefined) ? '__undefined' : v).
    replace(/\"__undefined\"/g, 'undefined'));
}


export function makeUUIDv4() {
  const hex = [...Array(256).keys()]
    .map(index => (index).toString(16).padStart(2, '0'));

  const r = crypto.randomBytes(16);

  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  
  const uuid = [...r.entries()]
    .map(([index, int]) => [4, 6, 8, 10].includes(index) ? `-${hex[int]}` : hex[int])
    .join('');

  return uuid;
}