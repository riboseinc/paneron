import { spawn, Worker, Thread } from 'threads';
import { app } from 'electron';
import log from 'electron-log';
import type WorkerMethods from '../worker/types';
import type { WorkerSpec } from '../worker/index';


/** Worker index. `workDir` should be platform-specific path. */
const WORKERS: { [workDir: string]: Promise<RepoWorkers> } = {};

// TODO: This layer may not be that necessary, considering loadedRepositories
// already caches workers—but we want it for “abstract” worker not attached
// to a working directory.


/**
 * IMPORTANT: Currently, two instances of the same worker are created,
 * and care should be taken to use each the right way.
 */
export interface RepoWorkers {
  /**
   * Sync worker can mutate repository (pull, push, commit changes).
   */
  sync: Thread & WorkerMethods

  /**
   * Reader worker should not mutate data, just read buffers.
   */
  reader: Thread & WorkerMethods
}


/** Terminates both workers for a repository. */
export async function terminateRepoWorkers(
  /** Platform-specific path to Git repository working directory root. */
  workDir: string,
) {
  log.debug("Repositories: Terminating workers for repo", workDir);

  const repoPromise = WORKERS[workDir];
  if (repoPromise) {
    delete WORKERS[workDir];
    try {
      const repo = await repoPromise;
      await Promise.allSettled([
        terminateWorker(repo.sync),
        terminateWorker(repo.reader),
      ]);
    } finally {
      log.debug("Repositories: Terminating workers for repo: Done", workDir);
    }
  } else {
    log.debug("Repositories: Terminating workers for repo: Nothing to be done", workDir);
  }
}


async function terminateAllWorkers() {
  log.debug("Repositories: Terminating all repo workers");
  await Promise.allSettled(Object.keys(WORKERS).map(terminateRepoWorkers));
  log.debug("Repositories: Terminating all repo workers: Done");
}


/** Returns repository workers, spawns if necessary. */
export function getRepoWorkers(
  /** Platform-specific path to Git repository working directory root. */
  workDir: string,
  branch: string,
): Promise<RepoWorkers> {

  if (!WORKERS[workDir]) {
    log.debug("Repositories: Workers not spawned yet, spawning now…", workDir);

    WORKERS[workDir] = new Promise((resolve, reject) => {
      terminateAllWorkers().
      finally(() => {
        Promise.all([
          spawnWorker(),
          spawnWorker(),
        ]).then(([ sync, reader ]) => {
          Promise.all([
            sync.openLocalRepo(workDir, branch, 'rw'),
            reader.openLocalRepo(workDir, branch, 'r'),
          ]).then(() => {
            resolve({ sync, reader })
          }).catch(reject);
        }).catch(reject);
      });
    });

  } else {
    log.debug("Repositories: Workers already spawned", workDir);
  }

  return WORKERS[workDir];
}


//app.on('quit', terminateAllWorkers);


/**
 * Spawns a repository worker.
 *
 * IMPORTANT: It’s caller’s responsibility to initialize, keep track of and terminate workers spawned this way.
 * For termination, use `terminateWorker()`.
 */
async function spawnWorker(): Promise<Thread & WorkerMethods> {
  return new Promise((resolve, reject) => {
    log.debug("Repositories: Spawning worker");

    spawn<WorkerSpec>(new Worker('../worker/index')).
    then((worker) => {
      Thread.events(worker).subscribe(evt => {
        if (evt.type === 'internalError') {
          log.error("Repositories: Worker error:", evt);
        } else if (evt.type === 'termination') {
          log.warn("Repositories: Worker termination:", evt);
        }
        // TODO: Respawn on worker exit?
      });
      log.debug("Repositories: Spawning worker: Done");
      resolve(worker);
    }).
    catch(reject);
  });
}


async function terminateWorker(worker: Thread & WorkerMethods) {
  log.debug("Repositories: Terminating worker");
  try {
    await worker.destroy();
  } catch (e) {
    log.error("Repositories: Error terminating worker (suppressed)", e);
  } finally {
    await Thread.terminate(worker);
  }
}


/**
 * Runs a one-off task on a repo worker, and kills the worker.
 * Does not open a repo.
 */
export async function oneOffWorkerTask<Result = any>
(task: (worker: Thread & WorkerMethods) => Promise<Result>) {
  const worker = await spawnWorker();

  const msg = `Running one-off worker for ${task.toString()}`;
  console.time(msg);
  try {
    return await task(worker);
  } finally {
    console.timeEnd(msg);
    log.error(`Terminating worker spawned for ${task.toString()}`);
    await terminateWorker(worker);
  }
}

// export const syncWorker = initializeWorker();
// export const readerWorker = initializeWorker();
