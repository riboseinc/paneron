import path from 'path';
import fs from 'fs-extra';

import { app } from 'electron';
import log from 'electron-log';

import type { CommitOutcome } from '@riboseinc/paneron-extension-kit/types/changes';

import { serializeMeta } from 'main/meta-serdes';
import { loadState } from 'state/manage';

import * as repositoriesIPC from '../ipc';

import { listDescendantPaths } from '../worker/buffers/list';

import { PANERON_REPOSITORY_META_FILENAME } from './meta';

import loadedDatasets from '../../datasets/main/loadedDatasets';

import { makeQueue, changesetToPathChanges } from 'utils';
import { makeUUIDv4 } from '../../main/utils';
import { deposixifyPath } from '../../main/fs-utils';

import type { PaneronRepository, GitRemote, Repository } from '../types';
import git from 'isomorphic-git';

import { getRepoWorkers, oneOffWorkerTask } from './workerManager';

import loadedRepositories from './loadedRepositories';

import { repoMetaDatasets } from '../../datasets/util';

import {
  updateRepositories,
  readRepositories,
  readRepoConfig,
  getNewRepoDefaults as getDefaults,
  setNewRepoDefaults as setDefaults,
} from './readRepoConfig';

import { readPaneronRepoMeta } from './meta';

import { saveAuth, getAuth } from './remoteAuth';


const repoOpQueue = makeQueue();


const DEFAULT_WORKING_DIRECTORY_CONTAINER = path.join(app.getPath('userData'), 'working_copies');
fs.ensureDirSync(DEFAULT_WORKING_DIRECTORY_CONTAINER);


repositoriesIPC.getNewRepoDefaults.main!.handle(async () => {
  try {
    return { defaults: await getDefaults() };
  } catch (e) {
    return { defaults: null };
  }
});


repositoriesIPC.setNewRepoDefaults.main!.handle(async (defaults) => {
  await setDefaults(defaults);
  return { success: true };
});


repositoriesIPC.getDefaultWorkingDirectoryContainer.main!.handle(async () => {
  return { path: DEFAULT_WORKING_DIRECTORY_CONTAINER };
});


repositoriesIPC.loadRepository.main!.handle(async ({ workingCopyPath }) => {
  if (workingCopyPath) {
    const status = await loadedRepositories.loadRepository(workingCopyPath);
    return status;
  } else {
    throw new Error("Missing repo working directory path");
  }
});

repositoriesIPC.unloadRepository.main!.handle(async ({ workingCopyPath }) => {
  if (workingCopyPath) {
    await loadedRepositories.unloadRepository(workingCopyPath);
  }
  return {};
});


repositoriesIPC.setRemote.main!.handle(async ({ workingCopyPath, url, username, password }) => {
  const w = loadedRepositories.getLoadedRepository(workingCopyPath).workers.sync;

  const auth = { username, password };
  const { isBlank, canPush } = await w.git_describeRemote({ url, auth });

  if (isBlank && canPush) {
    await updateRepositories((data) => {
      const existingConfig = data.workingCopies?.[workingCopyPath];
      if (existingConfig) {
        return {
          ...data,
          workingCopies: {
            ...data.workingCopies,
            [workingCopyPath]: {
              ...existingConfig,
              remote: { url, username, writeAccess: true },
            },
          }
        };
      } else {
        throw new Error("Cannot set remote URL for nonexistent working copy configuration");
      }
    });

    await w.git_addOrigin({
      url,
    });

    setImmediate(async () => {
      await repositoriesIPC.repositoriesChanged.main!.trigger({
        changedWorkingPaths: [workingCopyPath],
        deletedWorkingPaths: [],
        createdWorkingPaths: [],
      });
      await w.git_push({
        repoURL: url,
        auth,
      });
    });

    if (password) {
      try {
        await saveAuth(url, username, password);
      } catch (e) {
        log.error("Repositories: Unable to save password while initiating sharing", workingCopyPath, url, e);
      }
    }

    return { success: true };

  } else {
    log.warn("Repositories: Remote cannot be used to start sharing", workingCopyPath, url, username);
    throw new Error("Remote cannot be used to start sharing");
  }
});


repositoriesIPC.unsetWriteAccess.main!.handle(async ({ workingCopyPath }) => {
  await updateRepositories((data) => {
    const existingConfig = data.workingCopies?.[workingCopyPath];
    if (existingConfig?.remote?.writeAccess === true) {
      delete existingConfig.remote.writeAccess;
      return {
        ...data,
        workingCopies: {
          ...data.workingCopies,
          [workingCopyPath]: existingConfig,
        }
      };
    } else {
      throw new Error("Cannot unset remote URL: corresponding repository not found or has no write access");
    }
  });

  setImmediate(async () => {
    await repositoriesIPC.repositoriesChanged.main!.trigger({
      changedWorkingPaths: [workingCopyPath],
      deletedWorkingPaths: [],
      createdWorkingPaths: [],
    });
  });

  return { success: true };
});


repositoriesIPC.unsetRemote.main!.handle(async ({ workingCopyPath }) => {
  const w = loadedRepositories.getLoadedRepository(workingCopyPath).workers.sync;

  await updateRepositories((data) => {
    const existingConfig = data.workingCopies?.[workingCopyPath];
    if (existingConfig) {
      delete existingConfig.remote;
      return {
        ...data,
        workingCopies: {
          ...data.workingCopies,
          [workingCopyPath]: existingConfig,
        }
      };
    } else {
      throw new Error("Cannot unset remote URL for nonexistent working copy configuration");
    }
  });

  await w.git_deleteOrigin({
    workDir: workingCopyPath,
  });

  setImmediate(async () => {
    await repositoriesIPC.repositoriesChanged.main!.trigger({
      changedWorkingPaths: [workingCopyPath],
      deletedWorkingPaths: [],
      createdWorkingPaths: [],
    });
  });

  return { success: true };
});


repositoriesIPC.setAuthorInfo.main!.handle(async ({ workingCopyPath, author }) => {
  await updateRepositories((data) => {
    const existingConfig = data.workingCopies?.[workingCopyPath];
    if (existingConfig) {
      return {
        ...data,
        workingCopies: {
          ...data.workingCopies,
          [workingCopyPath]: {
            ...data.workingCopies[workingCopyPath],
            author,
          },
        }
      };
    } else {
      throw new Error("Cannot edit author info for nonexistent working copy configuration");
    }
  });

  await repositoriesIPC.repositoriesChanged.main!.trigger({
    changedWorkingPaths: [workingCopyPath],
    deletedWorkingPaths: [],
    createdWorkingPaths: [],
  });

  return { success: true };
});


repositoriesIPC.setLabel.main!.handle(async ({ workingCopyPath, label }) => {
  await updateRepositories((data) => {
    const existingConfig = data.workingCopies?.[workingCopyPath];
    if (existingConfig) {
      return {
        ...data,
        workingCopies: {
          ...data.workingCopies,
          [workingCopyPath]: {
            ...data.workingCopies[workingCopyPath],
            label,
          },
        }
      };
    } else {
      throw new Error("Cannot edit label for nonexistent working copy configuration");
    }
  });

  await repositoriesIPC.repositoriesChanged.main!.trigger({
    changedWorkingPaths: [workingCopyPath],
    deletedWorkingPaths: [],
    createdWorkingPaths: [],
  });

  return { success: true };
});


interface RepositoryLoadTimes {
  [workDir: string]: Date
}


repositoriesIPC.listRepositories.main!.handle(async ({ query: { matchesText, sortBy } }) => {
  const workingCopies = (await readRepositories()).workingCopies;

  const repositories: Repository[] =
    await Promise.all(Object.keys(workingCopies).map(async (workDir) => {
      let paneronMeta: PaneronRepository | undefined;
      try {
        paneronMeta = await readPaneronRepoMeta(workDir);
      } catch (e) {
        paneronMeta = undefined;
      }
      const mainBranch = workingCopies[workDir].mainBranch;

      let head = undefined;
      if (mainBranch) {
        try {
          head = await git.resolveRef({
            fs,
            dir: workDir,
            ref: mainBranch,
          });
        } catch (e) {
          log.error("Failed to resolve ref for repository", workDir, mainBranch);
        }
      }
      const gitMeta = {
        workingCopyPath: workDir,
        ...workingCopies[workDir],
        head,
      };
      return {
        gitMeta,
        paneronMeta,
      };
    }));

  const repositoryLoadTimes =
    (await loadState<RepositoryLoadTimes>('repositoryLoadTimes'));

  const filteredRepositories: Repository[] = repositories.filter(repo => {
    if (matchesText) {
      const normalizedSubstring = matchesText.toLowerCase();

      const workDirMatches = repo.gitMeta.workingCopyPath.indexOf(normalizedSubstring) >= 0;

      const normalizedTitle = repo.paneronMeta?.title?.toLowerCase();
      const titleMatches = normalizedTitle !== undefined && normalizedTitle.indexOf(normalizedSubstring) >= 0;

      const datasetIDs = repoMetaDatasets(repo.paneronMeta?.datasets).join('');
      const datasetIDsMatch = datasetIDs.indexOf(normalizedSubstring) >= 0;

      const matches: boolean = workDirMatches || titleMatches || datasetIDsMatch;
      return matches;
    } else {
      return true;
    }
  }).sort((repo1, repo2) => {
    const [title1, title2] = [repo1.paneronMeta?.title?.toLowerCase(), repo2.paneronMeta?.title?.toLowerCase()];
    if (title1 && title2) {
      return title1.localeCompare(title2);
    } else {
      return 0;
    }
  });

  let sortedRepositories: Repository[];
  if (sortBy === 'recentlyLoaded' && repositoryLoadTimes !== undefined) {
    sortedRepositories = repositories.sort((repo1, repo2) => {
      const loadTime1: Date | undefined = repositoryLoadTimes[repo1.gitMeta.workingCopyPath];
      const loadTime2: Date | undefined = repositoryLoadTimes[repo2.gitMeta.workingCopyPath];
      if (loadTime1 && loadTime2) {
        if (loadTime1 > loadTime2) {
          return -1;
        } else {
          return 1;
        }
      } else {
        return 0;
      }
    });
  } else {
    sortedRepositories = filteredRepositories;
  }

  return { objects: sortedRepositories };
});


function isRepositoryLoaded(workingCopyPath: string): boolean {
  try {
    loadedRepositories.getLoadedRepository(workingCopyPath);
    return true;
  } catch (e) {
    return false;
  }
}


repositoriesIPC.describeGitRepository.main!.handle(async ({ workingCopyPath }) => {
  return {
    info: await readRepoConfig(workingCopyPath),
    isLoaded: isRepositoryLoaded(workingCopyPath),
  };
});

repositoriesIPC.listCommits.main!.handle(async ({ workingCopyPath }) => {
  return await loadedRepositories.getLoadedRepository(workingCopyPath).workers.reader.repo_listCommits({});
});

repositoriesIPC.describeCommit.main!.handle(async ({ workingCopyPath, commitHash }) => {
  return await loadedRepositories.getLoadedRepository(workingCopyPath).workers.reader.repo_describeCommit({ commitHash });
});

repositoriesIPC.undoLatestCommit.main!.handle(async ({ workingCopyPath, commitHash }) => {
  const { remote } = await readRepoConfig(workingCopyPath);
  if (remote) {
    const auth = await getAuth(remote.url, remote.username);
    return await loadedRepositories.getLoadedRepository(workingCopyPath).workers.sync.
      repo_undoLatestCommit({ commitHash, remoteURL: remote.url, auth });
  }
  throw new Error("no remote")
});

repositoriesIPC.resetToCommit.main!.handle(async ({ workingCopyPath, commitHash }) => {
  try {
    loadedRepositories.getLoadedRepository(workingCopyPath);
    throw new Error("Cannot reset a loaded repository");
  } catch (e) {
    console.debug("resetToCommit: Calling worker");
    return await oneOffWorkerTask(w => w.git_resetToCommit({
      commitHash,
      workDir: workingCopyPath,
    }));
  }
});

repositoriesIPC.describeRepository.main!.handle(async ({ workingCopyPath }) => {
  if (workingCopyPath.trim() === '') {
    //log.warn("describeRepository: empty working directory path given", workingCopyPath);
    return {
      info: { gitMeta: { workingCopyPath, mainBranch: 'main' } },
      // ^ placeholder info.
      isLoaded: false,
    };
  }

  const gitRepo = await readRepoConfig(workingCopyPath);

  if (gitRepo.mainBranch) {
    gitRepo.head = await git.resolveRef({
      fs,
      dir: workingCopyPath,
      ref: gitRepo.mainBranch,
    });
  }

  let paneronRepo: PaneronRepository | undefined;
  try {
    paneronRepo = await readPaneronRepoMeta(workingCopyPath);
  } catch (e) {
    log.error("Unable to get Paneron repository information for working directory", workingCopyPath);
    paneronRepo = undefined;
  }
  return {
    info: {
      gitMeta: gitRepo,
      paneronMeta: paneronRepo,
    },
    isLoaded: isRepositoryLoaded(workingCopyPath),
  };
});


repositoriesIPC.updatePaneronRepository.main!.handle(async ({ workingCopyPath, info }) => {
  if (!info.title) {
    throw new Error("Proposed Paneron repository meta is missing title");
  }

  const existingMeta = await readPaneronRepoMeta(workingCopyPath);
  const { author } = await readRepoConfig(workingCopyPath);

  if (!author) {
    throw new Error("Repository configuration is missing author information");
  }

  const w = loadedRepositories.getLoadedRepository(workingCopyPath).workers.sync;

  const { newCommitHash } = await w.repo_updateBuffers({
    commitMessage: "Change repository title",
    author,
    bufferChangeset: {
      [PANERON_REPOSITORY_META_FILENAME]: {
        oldValue: serializeMeta(existingMeta),
        newValue: serializeMeta({
          ...existingMeta,
          title: info.title,
        }),
      }
    },
  });

  if (!newCommitHash) {
    throw new Error("Updating Paneron repository meta failed to return commit hash");
  }

  await repositoriesIPC.repositoriesChanged.main!.trigger({
    changedWorkingPaths: [workingCopyPath],
  });

  return { success: true };
});


repositoriesIPC.queryGitRemote.main!.handle(repoOpQueue.oneAtATime(async ({ url, username, password }) => {
  const auth = { username, password };
  if (!auth.password) {
    auth.password = (await getAuth(url, username)).password;
  }
  return await oneOffWorkerTask(w => w.git_describeRemote({ url, auth }));
}, ({ url }) => [url]));


repositoriesIPC.compareRemote.main!.handle(repoOpQueue.oneAtATime(async ({ workingCopyPath }) => {
  const { remote } = await readRepoConfig(workingCopyPath);
  if (remote) {
    const auth = await getAuth(remote.url, remote.username);
    console.debug("Comparing remote");
    return await oneOffWorkerTask(w => w.git_compareRemote({
      url: remote.url,
      workDir: workingCopyPath,
      auth,
    }));
  } else {
    throw new Error("No remote is configured");
  }
}, ({ workingCopyPath }) => [workingCopyPath]));


// function isValidBranchName(val: string): boolean {
//   return ['main', 'master'].indexOf(val) >= 0;
// }


repositoriesIPC.addRepository.main!.handle(async ({ gitRemoteURL, branch, username, password, author }) => {
  const workDirPath = path.join(DEFAULT_WORKING_DIRECTORY_CONTAINER, makeUUIDv4());

  if (fs.existsSync(workDirPath) || ((await readRepositories())).workingCopies[workDirPath] !== undefined) {
    throw new Error("Could not provide a valid non-occupied path to store local working directory for this repository");
  }

  if (branch === undefined || branch.trim() === '') {
    throw new Error("Main branch name is not specified");
  }

  // if (!isValidBranchName(branch)) {
  //   throw new Error("Unexpected main branch name")
  // }

  // Prepare auth
  const auth = { username, password };
  if (!auth.password) {
    log.error("Repositories: addRepository: password not supplied, trying to retrieve from OS storage");
    auth.password = (await getAuth(gitRemoteURL, username)).password;
  }

  // Check remote (validate requested branch exists and we have write access)
  const {
    canPush,
    availableBranches,
  } = await oneOffWorkerTask(w => w.git_describeRemote({ url: gitRemoteURL, auth }));

  if (availableBranches.indexOf(branch) < 0) {
    throw new Error(`No branch with requested name “${branch}” is found on upstream server`);
  }

  // Save auth info
  if (password) {
    await saveAuth(gitRemoteURL, username, password);
  }

  // Do the cloning
  const workers = await getRepoWorkers(workDirPath, branch);
  try {
    await workers.sync.git_clone({
      repoURL: gitRemoteURL,
      auth,
    });
  } catch (e) {
    // Cloning failed, try removing directory if it exists and re-throw the error.
    try {
      await oneOffWorkerTask(w => w.git_delete({
        workDir: workDirPath,
        yesReallyDestroyLocalWorkingCopy: true,
      }));
    } finally {}
    throw e;
  }

  // Update repository configuration
  await updateRepositories((data) => {
    if (data.workingCopies[workDirPath] !== undefined) {
      throw new Error("Working copy already exists");
    }
    const newData = { ...data };
    const remote: GitRemote = {
      url: gitRemoteURL,
      username,
    };
    if (canPush) {
      remote.writeAccess = true;
    }
    newData.workingCopies[workDirPath] = { remote, author, mainBranch: branch };
    return newData;
  });

  // Notify GUI
  repositoriesIPC.repositoriesChanged.main!.trigger({
    changedWorkingPaths: [],
    deletedWorkingPaths: [],
    createdWorkingPaths: [workDirPath],
  });

  //const workers = await getRepoWorkers(workDirPath);

  //await workers.sync.initialize({ workDirPath: workDirPath });

  //await workers.sync.git_elone({
  //  repoURL: gitRemoteURL,
  //  auth,
  //});

  //repositoriesChanged.main!.trigger({
  //  changedWorkingPaths: [workDirPath],
  //  deletedWorkingPaths: [],
  //  createdWorkingPaths: [],
  //});

  return { success: true, workDir: workDirPath };
});


repositoriesIPC.addDisconnected.main!.handle(async ({ gitRemoteURL, branch, username, password }) => {
  const workDirPath = path.join(DEFAULT_WORKING_DIRECTORY_CONTAINER, makeUUIDv4());
  if (fs.existsSync(workDirPath) || ((await readRepositories())).workingCopies[workDirPath] !== undefined) {
    throw new Error("Could not generate a valid non-occupied repository path inside given container.");
  }

  if (branch === undefined || branch.trim() === '') {
    throw new Error("Main branch name is not specified.");
  }

  const auth = { username, password };
  if (!auth.password) {
    auth.password = (await getAuth(gitRemoteURL, username)).password;
  }

  const workers = await getRepoWorkers(workDirPath, branch);

  try {
    await workers.sync.git_clone({
      repoURL: gitRemoteURL,
      auth,
    });
    await workers.sync.git_deleteOrigin({
      workDir: workDirPath,
    });

    await updateRepositories((data) => {
      const newData = { ...data };
      newData.workingCopies[workDirPath] = { mainBranch: branch };
      return newData;
    });

    repositoriesIPC.repositoriesChanged.main!.trigger({
      changedWorkingPaths: [],
      deletedWorkingPaths: [],
      createdWorkingPaths: [workDirPath],
    });

    return { workDir: workDirPath, success: true };

  } catch (e) {
    fs.removeSync(workDirPath);
    throw e;
  }
});


repositoriesIPC.createRepository.main!.handle(async ({ title, author, mainBranchName: branch }) => {
  const workDirPath = path.join(DEFAULT_WORKING_DIRECTORY_CONTAINER, makeUUIDv4());

  if (fs.existsSync(workDirPath)) {
    throw new Error("A repository with this name already exists. Please choose another name!");
  }

  if (branch === undefined || branch.trim() === '') {
    throw new Error("Missing main branch name");
  }

  // if (!isValidBranchName(branch)) {
  //   throw new Error("Unexpected main branch name")
  // }

  const w = (await getRepoWorkers(workDirPath, branch)).sync;

  const paneronMeta: PaneronRepository = {
    title: title ?? "Unnamed repository",
    datasets: [],
  };

  let outcome: CommitOutcome | undefined;
  try {
    log.debug("Repositories: Initializing new working directory", workDirPath);

    await w.git_init({
      defaultBranch: branch,
    });

    log.debug("Repositories: Writing Paneron meta", workDirPath);

    outcome = await w.repo_updateBuffers({
      commitMessage: "Initial commit",
      initial: true,
      author,
      // _dangerouslySkipValidation: true, // Have to, since we cannot validate data
      bufferChangeset: {
        [PANERON_REPOSITORY_META_FILENAME]: {
          oldValue: null,
          newValue: serializeMeta(paneronMeta),
        },
      },
    });
  } catch (e) {
    log.error("Repositories: Failed to initialize repository or make initial commit", e);
    outcome = undefined;
  }

  if (outcome?.newCommitHash) {

    await updateRepositories((data) => {
      if (data.workingCopies?.[workDirPath] !== undefined) {
        throw new Error("Repository already exists");
      }
      const newData = { ...data };
      newData.workingCopies[workDirPath] = {
        author,
        mainBranch: branch,
      };
      return newData;
    });

    log.debug("Repositories: Notifying about newly created repository");

    await loadedRepositories.loadRepository(workDirPath);

    repositoriesIPC.repositoriesChanged.main!.trigger({
      changedWorkingPaths: [],
      deletedWorkingPaths: [],
      createdWorkingPaths: [workDirPath],
    });

    log.debug("Repositories: Created repository");

    return { success: true };

  } else {

    if (outcome?.conflicts) {
      log.error("Failed to create a repository—conflicts when writing initial commit!", outcome.conflicts);
    } else {
      log.error("Failed to create a repository for some reason");
    }

    await oneOffWorkerTask(w => w.git_delete({
      workDir: workDirPath,

      // TODO: Make it so that yesReallyDestroyLocalWorkingCopy flag must be passed all the way from GUI
      yesReallyDestroyLocalWorkingCopy: true,
    }));

    throw new Error("Could not create a repository");

  }
});


repositoriesIPC.deleteRepository.main!.handle(async ({ workingCopyPath }) => {
  try {
    await loadedDatasets.unloadAll({ workDir: workingCopyPath });
    await loadedRepositories.unloadRepository(workingCopyPath);

  } catch (e) {
    log.warn("Repositories: Delete: Not loaded", workingCopyPath);
  }

  await oneOffWorkerTask(w => w.git_delete({
    workDir: workingCopyPath,

    // TODO: Make it so that yesReallyDestroyLocalWorkingCopy flag must be passed all the way from GUI
    yesReallyDestroyLocalWorkingCopy: true,
  }));

  await updateRepositories((data) => {
    if (data.workingCopies?.[workingCopyPath]) {
      const newData = { ...data };
      delete newData.workingCopies[workingCopyPath];
      return newData;
    }
    return data;
  });

  repositoriesIPC.repositoriesChanged.main!.trigger({
    changedWorkingPaths: [],
    deletedWorkingPaths: [workingCopyPath],
    createdWorkingPaths: [],
  });

  return { deleted: true };
});


repositoriesIPC.savePassword.main!.handle(async ({ workingCopyPath, remoteURL, username, password }) => {
  await loadedRepositories.unloadRepository(workingCopyPath);
  await saveAuth(remoteURL, username, password);
  await loadedRepositories.loadRepository(workingCopyPath);
  return { success: true };
});



// Manipulating data


repositoriesIPC.getBufferDataset.main!.handle(async ({ workingCopyPath, paths }) => {
  if (paths.length < 1) {
    return {};
  }

  const w = loadedRepositories.getLoadedRepository(workingCopyPath).workers.reader;

  return await w.repo_getBufferDataset({
    paths,
  });
});


repositoriesIPC.getBufferPaths.main!.handle(async ({ workingCopyPath, prefix }) => {
  const paths: string[] = [];
  for await (const p of listDescendantPaths(path.join(workingCopyPath, deposixifyPath(prefix)))) {
    if (p !== '/') {
      paths.push(p);
    }
  }
  return { bufferPaths: paths };
});


repositoriesIPC.updateBuffers.main!.handle(async ({
  workingCopyPath,
  commitMessage,
  bufferChangeset,
  ignoreConflicts,
}) => {
  const repoCfg = await readRepoConfig(workingCopyPath);

  if (!repoCfg.author) {
    throw new Error("Author information is missing in repository config");
  }

  const w = loadedRepositories.getLoadedRepository(workingCopyPath).workers.sync;

  const pathChanges = changesetToPathChanges(bufferChangeset);

  await loadedRepositories.reportBufferChanges(workingCopyPath, pathChanges);

  return await w.repo_updateBuffers({
    author: repoCfg.author,
    commitMessage,
    bufferChangeset,
    _dangerouslySkipValidation: ignoreConflicts,
  });
});


// getAbsoluteBufferPath.main!.handle(async ({ workingCopyPath, bufferPath }) => {
//   const w = loadedRepositories.getLoadedRepository(workingCopyPath).workers.reader;
//   const bufferDataset = await w.repo_readBuffers({
//     workDir: workingCopyPath,
//     rootPath: bufferPath,
//   });
//   const buff = Buffer.from(bufferDataset[path.posix.sep]);
//   if (pointsToLFS(buff)) {
//     const ptr = readPointer({ dir: workingCopyPath, content: buff });
//     await fs.access(ptr.objectPath);
//     return { absolutePath: path.join(workingCopyPath, ptr.objectPath) };
//   } else {
//     return { absolutePath: path.join(workingCopyPath, bufferPath) };
//   }
// });


// listObjectPaths.main!.handle(async ({ workingCopyPath, query }) => {
//   return await cache.listPaths({ workingCopyPath, query });
// });
//
//
// listAllObjectPathsWithSyncStatus.main!.handle(async ({ workingCopyPath }) => {
//   // TODO: Rename to just list all paths; implement proper sync status checker for subsets of files.
//
//   const paths = await cache.listPaths({ workingCopyPath });
//
//   const result: Record<string, FileChangeType> =
//     paths.map(p => ({ [`/${p}`]: 'unchanged' as const })).reduce((p, c) => ({ ...p, ...c }), {});
//
//   //const result = await w.listAllObjectPathsWithSyncStatus({ workDir: workingCopyPath });
//   log.info("Got sync status", JSON.stringify(result));
//
//   return result;
// });
