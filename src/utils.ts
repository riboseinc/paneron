/** General-purpose utilities that work both in Node and in browser. */

import AsyncLock from 'async-lock';
import type { Changeset, PathChanges } from '@riboseinc/paneron-extension-kit/types/changes';


/**
 * Returns given async function wrapped in such a way that it will
 * only execute one at a time,
 * waiting for previous invocation to complete if it’s ongoing.
 * (Doesn’t care whether previous invocation succeeds,
 * the call will be scheduled regardless.)
 */
export function makeSequential
<T, A extends unknown[]>
(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let workQueue: Promise<void> = Promise.resolve();
  return (...args) => {
    const call = () => fn(...args);
    const result = workQueue.then(call, call);
    workQueue = result.then(ignore, ignore);
    return result;
  };
}
const ignore = (_: any) => {};


/**
 * Queues based on async-lock.
 *
 * Use `oneAtATime` to run an async function in specified queues
 * without interfering with other async functions that may run in those queues.
 */
export function makeQueue() {
  const lock = new AsyncLock();
  return {
    /**
     * Queue a function to be run after the previous function in given queue
     * succeeds or fails. In case of multiple queues, waits until
     * every queue becomes free.
     */
    oneAtATime: function _oneAtATime<T, A extends unknown[]>(
      /** Function to be queued. */
      fn: (...args: A) => Promise<T>,
      /** Given function arguments, return queue IDs (“locking keys”). */
      occupyQueues: (...args: A) => string[],
    ): (...args: A) => Promise<T> {
      return async function runQueued(...args) {
        // Which queues do we want to occupy/which locks do we want to acquire?
        const queueIDs = occupyQueues(...args);
        //console.debug("Acquiring lock for queues to perform task", fn.name, args.toString(), queueIDs);
        // Acquire locks and run the function.
        return await lock.acquire(queueIDs, async function performTask () {
          //console.debug("Acquired lock for queues, performing task", fn.name, args.toString(), queueIDs);
          const result = await fn(...args)
          //console.debug("Done with task for queues", fn.name, args.toString(), queueIDs);
          return result;
        });
      }
    },
  };
}


// /**
//  * Queues based on p-limit/p-throttle (requires ESM support in bundler).
//  *
//  * Use `oneAtATime` to run an async function in specified queues
//  * without interfering with other async functions that may run in those queues.
//  */
//
// import pLimit from 'p-limit';
// import pThrottle from 'p-throttle';
// export function makeQueue2() {
//   interface Queue<T, A extends unknown[]> {
//     add: (
//       fn: (...args: A) => Promise<T>,
//       ...args: A) => Promise<T>,
//     /**
//      * Returns a promise that resolves when current queue becomes empty.
//      * Optionally executes given callback.
//      */
//     onComplete: (func?: () => void) => Promise<void>,
//   }
//   const queues: Record<string, Queue<any, any>> = {};
//   function getQueue<T, A extends unknown[]>
//   (key: string): Queue<T, A> {
//     if (!queues[key]) {
//       const limit = pLimit(1);
//       const throttle = pThrottle({ limit: Infinity, interval: 0 });
//       const q: Queue<T, A> = {
//         add: (func, ...args) => throttle(() => limit(func, ...args))(),
//         onComplete: (func) => limit(func ?? (() => void 0)),
//       }
//       queues[key] = q;
//     }
//     return queues[key];
//   }
//   return {
//     /**
//      * Queue a function to be run after the previous function in given queue
//      * succeeds or fails. In case of multiple queues, waits until
//      * every queue becomes free.
//      */
//     oneAtATime: function _oneAtATime<T, A extends unknown[]>(
//       /** Function to be queued. */
//       fn: (...args: A) => Promise<T>,
//       /** Given function arguments, return queue IDs (“locking keys”). */
//       occupyQueues: (...args: A) => string[],
//     ): (...args: A) => Promise<T> {
//       return async function runQueued(...args) {
//         // Which queues do we want to occupy? (Which locks do we want to acquire?)
//         const queues = occupyQueues(...args).map(getQueue);
//
//         // Acquire the locks:
//
//         // Wait until all those queues settle
//         await Promise.allSettled(queues.map(q => q.onComplete()));
//         // Start our work
//         const promise = fn(...args);
//         // Occupy all given queues with it
//         queues.map(q => q.add(() => promise));
//
//         // We have acquired the locks. Once the promise resolves,
//         // queues will be able to take new tasks.
//
//         // Resolve when work completes
//         return await promise;
//       }
//     },
//   };
// }



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

export function joinPaths(...parts: string[]): string {
  return normalizePath(parts.map(normalizePath).join('/'));
}

export function normalizePath(path: string): string {
  return path
    .replace(/\/\.\//g, '/') // Replace '/./' with '/'
    .replace(/\/{2,}/g, '/') // Replace consecutive '/'
    .replace(/^\/\.$/, '/') // if path === '/.' return '/'
    .replace(/^\.\/$/, '.') // if path === './' return '.'
    .replace(/^\.\//, '') // Remove leading './'
    .replace(/\/\.$/, '') // Remove trailing '/.'
    .replace(/(.+)\/$/, '$1') // Remove trailing '/'
    .replace(/^$/, '.'); // if path === '' return '.'
}


export function stripLeadingSlash(aPath: string): string {
  return aPath.replace(/^\//, '');
}


export function stripTrailingSlash(aPath: string): string {
  return aPath.replace(/\/$/, '');
}
