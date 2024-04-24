import fs from 'fs-extra';
import { Subscription } from 'observable-fns';
import { app } from 'electron';
import log from 'electron-log';

import type { PathChanges } from '@riboseinc/paneron-extension-kit/types/changes';

import type { GitRepository, RepoStatus } from '../types';
import { repositoryBuffersChanged, loadedRepositoryStatusChanged } from '../ipc';

import { getRepoWorkers, RepoWorkers, terminateRepoWorkers } from './workerManager';
import { readRepoConfig } from './readRepoConfig';
import { getAuth } from './remoteAuth';
import { makeQueue } from '../../utils';


const repoQueue = makeQueue();


/** Holds currently loaded (synchronized) repositories. */
const loadedRepositories: {
  [workingCopyPath: string]: {
    workers: RepoWorkers;
    loadTime: Date;

    statusStream: Subscription<RepoStatus>;
    // This status is set by subscription to worker events and is not to be relied on.
    latestStatus?: RepoStatus;

    nextSyncTimeout?: ReturnType<typeof setTimeout>;
  };
} = {};


const MAX_LOADED_REPOSITORIES: number = 1;

const INITIAL_STATUS: RepoStatus = { busy: { operation: 'initializing' } };


/**
 * Returns loaded repository structure only if it’s already loaded.
 * If not loaded, throws an error and does not cause the repository to load.
 */
export function getLoadedRepository(workDir: string) {
  if (loadedRepositories[workDir]) {
    return loadedRepositories[workDir];
  } else {
    throw new Error("Repository is not loaded");
  }
}


/**
 * Loads a repository, unless it’s already loaded.
 * Loading a repo causes it to sync in background.
 * Unloading can be monitored via `loadedRepositoryStatusChanged` event.
 *
 * @param workingCopyPath path to Git working directory
 * @returns Promise<RepoStatus>
 */
async function _loadRepository(workingCopyPath: string): Promise<RepoStatus> {
  if (loadedRepositories[workingCopyPath]) {
    log.silly(
      "Repositories: Load: Already loaded",
      workingCopyPath,
      loadedRepositories[workingCopyPath].latestStatus);
    return loadedRepositories[workingCopyPath].latestStatus ?? { status: 'ready', localHead: '' };
  }

  log.silly("Repositories: Load: Reading config", workingCopyPath);

  let repoCfg: GitRepository;
  try {
    repoCfg = await readRepoConfig(workingCopyPath);
  } catch (e) {
    log.warn("Repositories: Configuration for working copy cannot be read.", workingCopyPath);
    return { status: 'invalid-working-copy' };
  }

  log.silly("Repositories: Load: Validating working directory path", workingCopyPath);

  let workDirPathExists: boolean;
  let workDirPathIsWorkable: boolean;
  try {
    workDirPathIsWorkable = (await fs.stat(workingCopyPath)).isDirectory() === true;
    workDirPathExists = true;
  } catch (e) {
    if (!repoCfg.remote?.url) {
      log.error("Repositories: Configuration for working copy exists, but working copy directory is missing and no remote is specified.", workingCopyPath);
      return { status: 'invalid-working-copy' };
    } else {
      log.debug("Repositories: Configuration for working copy exists, but working copy directory is missing. Will attempt to clone again.", workingCopyPath);
      workDirPathExists = false;
      workDirPathIsWorkable = true;
    }
  }

  if (!workDirPathIsWorkable) {
    log.error("Repositories: Working copy in filesystem is invalid (not a directory?)", workingCopyPath);
    return { status: 'invalid-working-copy' };
  }

  async function reportStatus(status: RepoStatus) {
    const previousStatus = loadedRepositories[workingCopyPath]?.latestStatus ?? null;
    const statusChanged = JSON.stringify(previousStatus) !== JSON.stringify(status);

    if (statusChanged) {
      await loadedRepositoryStatusChanged.main!.trigger({
        workingCopyPath,
        status,
      });
    }
    if (loadedRepositories[workingCopyPath]) {
      loadedRepositories[workingCopyPath].latestStatus = status;
    } else {
      statusStream.unsubscribe();
    }
  }

  log.silly("Repositories: Load: Spawning workers", workingCopyPath);

  const workers = await getRepoWorkers(workingCopyPath, repoCfg.mainBranch);

  log.silly("Repositories: Load: Subscribing to status updates", workingCopyPath);

  const statusStream = workers.sync.streamStatus().subscribe(reportStatus);

  loadedRepositories[workingCopyPath] = {
    workers,
    statusStream,
    loadTime: new Date(),
  };

  // Clean up previously loaded repositories
  const loadedSorted = Object.entries(loadedRepositories).
    sort((r1, r2) => r1[1].loadTime > r2[1].loadTime ? -1 : 1).
    slice(MAX_LOADED_REPOSITORIES).
    map(([workDir, ]) => workDir);
  try {
    log.debug("Repositories: Load: Unloading excess repositories", loadedSorted);
    await Promise.allSettled(loadedSorted.map(unloadRepository));
  } catch (e) {
    log.error("Repositories: Load: Unloading excess repositories: Error", e);
  }

  log.silly("Repositories: Load: Kicking off sync", workingCopyPath);

  // This will schedule itself forever, until repository is unloaded.
  syncRepoRepeatedly(workingCopyPath, undefined, workers);

  //app.on('quit', () => { unloadRepository(workingCopyPath); });

  log.silly("Repositories: Load: Validating working directory", workingCopyPath);

  const workDirIsValid = await workers.sync.git_workDir_validate({
    workDir: workingCopyPath,
  });

  const { commitHash: localHead } = await workers.sync.repo_getCurrentCommit({});

  if (workDirPathExists && !workDirIsValid) {
    log.warn("Repositories: Load: Working copy in filesystem is invalid (not a Git repo?)", workingCopyPath);
    await loadedRepositoryStatusChanged.main!.trigger({
      workingCopyPath,
      status: { busy: { operation: 'initializing' } },
    });
    return INITIAL_STATUS;

  } else {
    log.silly("Repositories: Load: Finishing", workingCopyPath);
    await loadedRepositoryStatusChanged.main!.trigger({
      workingCopyPath,
      status: { status: 'ready', localHead },
    });
    return { status: 'ready', localHead };
  }
}


const loadRepository = repoQueue.oneAtATime(_loadRepository, (w) => [w]);


/**
 * Unload effectively cancels repo status subscription,
 * clears update timeout, terminates workers, and sends an unloaded event.
 *
 * Has no effect if is not loaded.
 */
async function _unloadRepository(workingCopyPath: string) {
  await terminateRepoWorkers(workingCopyPath);

  if (loadedRepositories[workingCopyPath]) {
    loadedRepositories[workingCopyPath].statusStream?.unsubscribe();
    clearTimeout(loadedRepositories[workingCopyPath].nextSyncTimeout as number | undefined);
    delete loadedRepositories[workingCopyPath];
  }

  await loadedRepositoryStatusChanged.main!.trigger({
    workingCopyPath,
    status: { status: 'unloaded' },
  });
}


const unloadRepository = repoQueue.oneAtATime(_unloadRepository, (w) => [w]);


// Sync sequence

const REPOSITORY_SYNC_INTERVAL_MS = 15000;
const REPOSITORY_SYNC_INTERVAL_AFTER_ERROR_MS = 15000;

// TODO: Only sync a repository if one of its datasets is opened?
function syncRepoRepeatedly(
  workingCopyPath: string,
  logLevel: 'all' | 'warnings' = 'all',
  workers: RepoWorkers,
): void {

  const repoSyncLog: (
    meth: 'silly' | 'debug' | 'info' | 'warn' | 'error',
    ...args: Parameters<typeof log.debug>
  ) => ReturnType<typeof log.debug> = (meth, ...args) => {
    const _msg = args.shift();
    const doLog = (
      logLevel === 'all' ||
      logLevel === 'warnings' && (meth === 'warn' || meth === 'error'));
    if (doLog) {
      const msg = `Repositories: Syncing ${workingCopyPath}: ${_msg}`;
      log[meth](msg, ...args);
    }
  };

  function cancelSync() {
    repoSyncLog('info', "Cancelling sync");
    clearTimeout(loadedRepositories[workingCopyPath]?.nextSyncTimeout as number | undefined);
  }

  function scheduleSync(msec: number) {
    cancelSync();
    if (loadedRepositories[workingCopyPath]) {
      loadedRepositories[workingCopyPath].nextSyncTimeout = setTimeout(_sync, msec);
      repoSyncLog('info', `Scheduled sync in ${msec} ms`);
    } else {
      repoSyncLog('warn', "Not scheduling sync: repository not loaded");
    }
  }

  if (loadedRepositories[workingCopyPath]?.nextSyncTimeout) {
    repoSyncLog('warn', "Sync already scheduled, doing nothing");
    return;
  }

  async function _sync(): Promise<void> {
    const w = workers.sync;

    repoSyncLog('info', "Beginning sync attempt");

    // Do our best to avoid multiple concurrent sync runs on one repo and clear sync timeout, if exists.
    cancelSync();

    // 1. Check that repository is OK.
    // If something is utterly broken, unload repository.
    // If sync is not possible, operation in latest status snapshot
    // indicates that we are awaiting user input, etc., clear status and cancel further sync
    // (but don’t unload).

    // 1.1. Check we’re “loaded”
    let repoCfg: GitRepository | null;
    if (!loadedRepositories[workingCopyPath]) {
      repoSyncLog('info', "Not loaded; clearing status cache and aborting sync");
      return await unloadRepository(workingCopyPath);
    }

    // 1.2. Check there’s nothing in progress
    const isBusy = loadedRepositories[workingCopyPath].latestStatus?.busy;
    switch (isBusy?.operation) {
      case 'pulling':
      case 'pushing':
      case 'cloning':
        if (isBusy.awaitingPassword) {
          repoSyncLog('error', "Password stored in credential manager didn’t work, aborting sync", JSON.stringify(isBusy.operation));
          return cancelSync();
        }
    }
    repoSyncLog('debug', "No operation is in progress, proceeding…");

    // 1.3. Check configuration
    repoSyncLog('debug', "Checking configuration");
    try {
      repoCfg = await readRepoConfig(workingCopyPath);
      if (!repoCfg.author && repoCfg.remote) {
        repoSyncLog('error', "Configuration is missing author info or remote, required for remote sync");
        return await unloadRepository(workingCopyPath);
      }
    } catch (e) {
      repoSyncLog('error', "Configuration cannot be read", e);
      return await unloadRepository(workingCopyPath);
    }

    // 1.4. Check that working directory is OK.
    // If if fails to stat, abort everything.
    try {
      await fs.stat(workingCopyPath);
    } catch (e) {
      repoSyncLog('warn', "Working copy path failed to stat", e);
      return await unloadRepository(workingCopyPath);
    }

    // 1.5. Check that there are no recent commits (less than 30 seconds old).
    // If there are, reschedule sync a bit later to allow the user to ninja undo.
    // Undo feature may do a reset which can break if commit is pushed.

    try {
      const { commitHash } = await w.repo_getCurrentCommit({});
      const { commit: { committedAt, authoredAt } } = await w.repo_describeCommit({ commitHash });
      const commitTimestamp = committedAt || authoredAt;
      if (commitTimestamp) {
        const nowSeconds = Date.now() / 1000;
        const secondsElapsed = nowSeconds - commitTimestamp;
        const WAIT_AFTER_COMMIT_SECONDS = 30;
        if (secondsElapsed < WAIT_AFTER_COMMIT_SECONDS) {
          const cooldown = WAIT_AFTER_COMMIT_SECONDS - secondsElapsed;
          repoSyncLog('info', "Recent commit is too fresh, rescheduling sync in seconds:", cooldown);
          return scheduleSync(cooldown * 1000);
        }
      } else {
        repoSyncLog(
          'error',
          "Cannot detect latest commit timestamp",
          "neither commit nor author timestamp is present");
        return cancelSync();
      }
    } catch (e) {
      repoSyncLog(
        'error',
        "Cannot detect latest commit timestamp due to error",
        e);
      return cancelSync();
    }

    // 2. Perform actual sync.
    try {
      if (repoCfg.remote && repoCfg.author) {
        const auth = await getAuth(repoCfg.remote.url, repoCfg.remote.username);

        repoSyncLog('info', "Got auth data; pulling…");

        const { oidBeforePull, oidAfterPull } = await w.git_pull({
          repoURL: repoCfg.remote.url,
          auth,
          author: repoCfg.author,
          _presumeCanceledErrorMeansAwaitingAuth: true,
        });

        repoSyncLog('info', `Pull completed: from ${oidBeforePull} to ${oidAfterPull}`);

        if (repoCfg.remote.writeAccess) {
          repoSyncLog('debug', "Got write access; pushing…");
          await w.git_push({
            repoURL: repoCfg.remote.url,
            auth,
            _presumeRejectedPushMeansNothingToPush: true,
            _presumeCanceledErrorMeansAwaitingAuth: true,
          });
        }

        repoSyncLog('info', "Finishing sync attempt");

        repoSyncLog('debug', "Cooldown before next sync", REPOSITORY_SYNC_INTERVAL_MS);
        return scheduleSync(REPOSITORY_SYNC_INTERVAL_MS);

      } else {
        repoSyncLog('debug', "Remote or author is not specified, cancelling sync");
        return cancelSync();
        // repoSyncLog('debug', "Cooldown before next sync", REPOSITORY_SYNC_INTERVAL_AFTER_ERROR_MS);
        // if (loadedRepositories[workingCopyPath]) {
        //   loadedRepositories[workingCopyPath].nextSyncTimeout = setTimeout(_sync, REPOSITORY_SYNC_INTERVAL_AFTER_ERROR_MS);
        // }
      }

    } catch (e) {
      repoSyncLog('error', "Sync failed", e);
      repoSyncLog('debug', "Cooldown before next sync attempt", REPOSITORY_SYNC_INTERVAL_AFTER_ERROR_MS);
      return scheduleSync(REPOSITORY_SYNC_INTERVAL_AFTER_ERROR_MS);
    }
  }

  repoSyncLog('debug', "Scheduling sync immediately");
  cancelSync();
  return scheduleSync(500);
}


async function reportBufferChanges(
  workingCopyPath: string,
  changedPaths: PathChanges,
) {
  if (Object.keys(changedPaths).length > 0) {
    await repositoryBuffersChanged.main!.trigger({
      workingCopyPath,
      changedPaths,
    });
  }
}


//app.on('quit', async () => {
//  for (const workingCopyPath of Object.keys(loadedRepositories)) {
//    await unloadRepository(workingCopyPath);
//  }
//});


export default {
  getLoadedRepository,
  loadRepository,
  unloadRepository,
  reportBufferChanges,
};
