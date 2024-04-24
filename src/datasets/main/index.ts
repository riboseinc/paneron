import { removeSync } from 'fs-extra';
import nodePath from 'path';
import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import log from 'electron-log';
import type { BufferChange, BufferChangeset } from '@riboseinc/paneron-extension-kit/types/buffers';
import { INITIAL_INDEX_STATUS } from '@riboseinc/paneron-extension-kit/types/indexes';

import { joinPaths, stripLeadingSlash, stripTrailingSlash, forceSlug } from 'utils';
import { checkPathIsOccupied } from 'main/fs-utils';
import { serializeMeta } from 'main/meta-serdes';

import {
  // TODO: Define a more specific datasets changed event?
  repositoriesChanged,
  repositoryBuffersChanged,
} from 'repositories/ipc';

import type { PaneronRepository } from 'repositories/types';

import { readRepoConfig } from 'repositories/main/readRepoConfig';
import { getLoadedRepository } from 'repositories/main/loadedRepositories';
import {
  readPaneronRepoMeta,
  PANERON_REPOSITORY_META_FILENAME,
  DATASET_FILENAME,
  readDatasetMeta,
} from 'repositories/main/meta';

import { parseMapReduceChain } from '../util';
import {
  deleteDataset,
  getDatasetInfo,
  initializeDataset,
  loadDataset,
  proposeDatasetPath,
  getObjectDataset,
  getOrCreateFilteredIndex,
  describeIndex,
  unloadDataset,
  getFilteredObject,
  locateFilteredIndexPosition,
  mapReduce,
  updateObjects,
  listRecentlyOpenedDatasets,
  updateSubtree,
  addFromFilesystem,
} from '../ipc';

import { API as Datasets } from '../types';

import loadedDatasets from './loadedDatasets';
import { getObjectDataset as getDataset } from './objects/read';

import {
  addExternal,
  updateObjects as _updateObjects,
  updateTree as _updateTree,
} from './objects/update';

import {
  list as _listRecentlyOpenedDatasets,
  record as _recordRecentlyOpenedDataset,
} from './recent';


getDatasetInfo.main!.handle(async ({ workingCopyPath, datasetID }) => {
  if (!datasetID.trim()) {
    return { info: null }
  }
  try {
    return { info: await readDatasetMeta(workingCopyPath, datasetID) };
  } catch (e) {
    log.error("Error reading dataset meta", e);
    return { info: null };
  }
});


proposeDatasetPath.main!.handle(async ({ workingCopyPath, datasetPath }) => {
  if (!datasetPath.trim || !datasetPath.trim()) {
    throw new Error("Missing dataset path.");
  }

  const dir = forceSlug(datasetPath);
  const fullPath = nodePath.join(workingCopyPath, dir);

  // For check to succeed, the path must not exist at all.

  // TODO: Accept a pre-existing empty directory as new dataset location?
  // We would have to validate it’s absolutely empty.
  const isOccupied = checkPathIsOccupied(fullPath);

  if (isOccupied) {
    return { path: undefined };
  } else {
    return { path: dir };
  }
});


initializeDataset.main!.handle(async ({ workingCopyPath, meta: datasetMeta, datasetPath, initialBufferDataset }) => {
  if (!datasetPath.trim || !datasetPath.trim()) {
    throw new Error("Invalid or missing dataset path");
  }

  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Repository configuration is missing author information");
  }

  // Prepare repo meta update
  const oldRepoMeta = await readPaneronRepoMeta(workingCopyPath);

  if (oldRepoMeta.dataset || oldRepoMeta.datasets === undefined) {
    throw new Error("This repository does not support multiple datasets");
  }

  const newRepoMeta: PaneronRepository = {
    ...oldRepoMeta,
    dataset: undefined,
    datasets: {
      ...oldRepoMeta.datasets,
      [datasetPath]: true,
    },
  };
  const repoMetaChange: BufferChange = {
    oldValue: serializeMeta(oldRepoMeta),
    newValue: serializeMeta(newRepoMeta),
  };

  // Prepare dataset meta addition
  const datasetMetaAddition: BufferChange = {
    oldValue: null,
    newValue: serializeMeta(datasetMeta),
  };

  const repos = getLoadedRepository(workingCopyPath).workers.sync;

  const datasetMetaPath = joinPaths(datasetPath, DATASET_FILENAME);

  const bufferChangeset: BufferChangeset = {}

  if (initialBufferDataset) {
    const initialData: BufferChangeset = {};
    for (const [_path, _blob] of Object.entries(initialBufferDataset)) {
      const repoRelativeBufferPath = joinPaths(
        stripTrailingSlash(datasetPath),
        stripLeadingSlash(_path),
      );
      initialData[repoRelativeBufferPath] = { newValue: _blob };
    }
    Object.assign(bufferChangeset, initialData);
  }

  bufferChangeset[datasetMetaPath] = datasetMetaAddition;
  bufferChangeset[PANERON_REPOSITORY_META_FILENAME] = repoMetaChange;

  const decoder = new TextDecoder();
  try {
    log.info(
      "datasets: Initializing with buffer changeset",
      JSON.stringify(
        Object.values(bufferChangeset).map(v => v.newValue ? decoder.decode(v.newValue) : v),
        undefined,
        4),
      datasetPath);
  } catch (e) {}

  const { newCommitHash } = await repos.repo_updateBuffers({
    commitMessage: `Initialize dataset at ${datasetPath}`,
    author,
    bufferChangeset,
  });

  if (newCommitHash) {
    await repositoriesChanged.main!.trigger({
      changedWorkingPaths: [workingCopyPath],
    });
    await repositoryBuffersChanged.main!.trigger({
      workingCopyPath,
      changedPaths: {
        [datasetMetaPath]: true,
        [PANERON_REPOSITORY_META_FILENAME]: true,
      },
    });
    return { info: datasetMeta };
  } else {
    throw new Error("Dataset initialization failed to return a commit hash");
  }
});


const INDEX_DB_ROOT = nodePath.join(app.getPath('userData'), 'index-dbs');


function clearIndexes() {
  return removeSync(INDEX_DB_ROOT);
}

clearIndexes();


listRecentlyOpenedDatasets.main!.handle(async () => {
  return {
    datasets: await _listRecentlyOpenedDatasets(),
  };
});


loadDataset.main!.handle(async ({ workingCopyPath, datasetID }) => {
  await _recordRecentlyOpenedDataset(workingCopyPath, datasetID);

  log.debug("Datasets: Load: Ensuring cache root dir…", INDEX_DB_ROOT);

  //log.debug("Datasets: Load: Getting loaded repository worker");
  //const repoWorker = getLoadedRepository(workingCopyPath).workers.sync;

  log.debug("Datasets: Load: Loading dataset…");

  await loadedDatasets.load({ workDir: workingCopyPath, datasetID, cacheRoot: INDEX_DB_ROOT });

  log.debug("Datasets: Load: Done");

  return { success: true };
});


unloadDataset.main!.handle(async ({ workingCopyPath, datasetID }) => {
  //const repoWorker = getLoadedRepository(workingCopyPath).workers.sync;
  log.debug("Unloading dataset", workingCopyPath, datasetID);
  await loadedDatasets.unload({ workDir: workingCopyPath, datasetID });
  return { success: true };
});


getOrCreateFilteredIndex.main!.handle(async ({ workingCopyPath, datasetID, queryExpression, keyExpression }) => {
  //const repoWorker = getLoadedRepository(workingCopyPath).workers.sync;

  const { indexID } = await loadedDatasets.getOrCreateFilteredIndex({
    workDir: workingCopyPath,
    datasetID,
    queryExpression,
    keyExpression,
  });

  //repoWorker.ds_index_streamStatus({
  //  workDir: workingCopyPath,
  //  datasetDir: datasetPath,
  //  indexID,
  //}).subscribe(status => {
  //  indexStatusChanged.main!.trigger({ workingCopyPath, datasetPath, status, indexID });
  //});

  return { indexID };
});


describeIndex.main!.handle(async ({ workingCopyPath, datasetID, indexID }) => {
  if (indexID !== '') {
    //const repoWorker = getLoadedRepository(workingCopyPath).workers.sync;
    return await loadedDatasets.describeIndex({
      workDir: workingCopyPath,
      datasetID,
      indexID,
    });
  } else {
    return { status: INITIAL_INDEX_STATUS };
  }
});


getObjectDataset.main!.handle(async ({ workingCopyPath, datasetID, objectPaths, resolveLFS }) => {
  //const repoWorker = getLoadedRepository(workingCopyPath).workers.sync;
  const data = await getDataset({
    workDir: workingCopyPath,
    datasetID,
    objectPaths,
    resolveLFS,
  });
  return { data };
});


getFilteredObject.main!.handle(async ({ workingCopyPath, datasetID, indexID, position }) => {
  if (!indexID) {
    return { objectPath: '' };
  } else {
    //const repoWorker = getLoadedRepository(workingCopyPath).workers.sync;
    const { objectPath } = await loadedDatasets.getFilteredObject({
      workDir: workingCopyPath,
      datasetID,
      indexID,
      position,
    });
    return { objectPath };
  }
});


locateFilteredIndexPosition.main!.handle(async ({ workingCopyPath, datasetID, indexID, objectPath }) => {
  if (!indexID || !objectPath) {
    return { position: null };
  } else {
    try {
      return await loadedDatasets.locatePositionInFilteredIndex({
        workDir: workingCopyPath,
        datasetID,
        indexID,
        objectPath,
      });
    } catch (e) {
      //log.warn("Failed to retrieve index position for object path", objectPath, indexID, e);
      return { position: null };
    }
  }
});


mapReduce.main!.handle(async ({ workingCopyPath, datasetID, chains }) => {
  const parsedChains: Datasets.Util.MapReduceChain<any>[] = [];

  //log.debug("mapReduce: pre-processing chains", chains);

  for (const [chainID, chain] of Object.entries(chains)) {
    parsedChains.push(parseMapReduceChain(chainID, chain));
  }

  //log.debug("mapReduce: processing chains", parsedChains);

  const chainResults = (await Promise.allSettled(parsedChains.map(async (c) =>
    ({ [c.id]: await loadedDatasets.mapReduce(workingCopyPath, datasetID, c.predicate, c.map, c.reduce) })
  )))

  const fulfilledResults: Record<string, unknown>[] = chainResults.
    filter(r => r.status === 'fulfilled').
    map(r => (r as PromiseFulfilledResult<Record<string, unknown>>).value);

  if (fulfilledResults.length != chainResults.length) {
    const errResults: string[] = chainResults.
      filter(r => r.status !== 'fulfilled').
      map(r => (r as PromiseRejectedResult).reason.message);
    const errors = errResults.map(r => r.split('\n')[0]).join('; ');
    throw new Error(`mapReduce failed: ${errors}`);
  }

  return fulfilledResults.reduce((prev, curr) => ({ ...prev, ...curr }), {});
});


updateObjects.main!.handle(async ({ workingCopyPath, datasetID, objectChangeset, commitMessage, _dangerouslySkipValidation }) => {
  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Repository configuration is missing author information");
  }
  // TODO: Save new version in `updateObjects()` additionally, using some filesystem-based mechanism?
  return await _updateObjects({
    workDir: workingCopyPath,
    datasetID,
    objectChangeset,
    commitMessage,
    _dangerouslySkipValidation,
    author,
  });
});


updateSubtree.main!.handle(async ({ workingCopyPath, datasetID, commitMessage, subtreeRoot, newSubtreeRoot }) => {
  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Repository configuration is missing author information");
  }
  return await _updateTree({
    workDir: workingCopyPath,
    datasetID,
    commitMessage,
    author,
    oldSubtreePath: subtreeRoot,
    newSubtreePath: newSubtreeRoot,
  });
});


addFromFilesystem.main!.handle(async ({ workingCopyPath, datasetID, commitMessage, dialogOpts, targetPath, opts }) => {
  const window = BrowserWindow.getFocusedWindow();
  if (window === null) { throw new Error("Unable to choose file(s): no focused window detected"); }

  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Repository configuration is missing author information");
  }

  const allowMultiple = opts.replaceTarget !== true && dialogOpts.allowMultiple;

  const properties: OpenDialogOptions["properties"] = [
    'openFile',
  ]
  if (allowMultiple) {
    properties.push('multiSelections');
  }

  const result = await dialog.showOpenDialog(window, {
    properties,
  });

  const filepaths = (result.filePaths || []);

  if (!allowMultiple && filepaths.length > 1) {
    throw new Error("More than one file was selected");
  }
  if (filepaths.length < 1) {
    return { commitOutcome: null };
  }

  const commitOutcome = await addExternal({
    workDir: workingCopyPath,
    datasetID,
    offloadToLFS: opts.offloadToLFS,
    commitMessage,
    absoluteFilepaths: filepaths,
    targetPath,
    replaceTarget: opts.replaceTarget,
    author,
  });

  return { commitOutcome };
});


deleteDataset.main!.handle(async ({ workingCopyPath, datasetID }) => {
  // TODO: Resolve datasetID?

  const w = getLoadedRepository(workingCopyPath).workers.sync;

  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Missing author information in repository config");
  }

  const repoMeta = await readPaneronRepoMeta(workingCopyPath);
  if (!repoMeta.datasets?.[datasetID]) {
    throw new Error("Dataset is not found in Paneron repository meta");
  }

  // To ensure we are deleting a Paneron dataset
  await readDatasetMeta(workingCopyPath, datasetID);

  // Delete dataset tree
  const deletionResult = await w.repo_deleteTree({
    commitMessage: `Delete dataset at ${datasetID}`,
    author,
    treeRoot: datasetID,
  });

  if (!deletionResult.newCommitHash) {
    throw new Error("Failed while deleting dataset object tree");
  }

  // Update repo meta
  const oldMetaBuffer = serializeMeta(repoMeta);
  delete repoMeta.datasets[datasetID];
  const newMetaBuffer = serializeMeta(repoMeta);

  const datasetMetaPath = joinPaths(datasetID, DATASET_FILENAME);

  const repoMetaUpdateResult = await w.repo_updateBuffers({
    commitMessage: "Record dataset deletion",
    author,
    bufferChangeset: {
      [PANERON_REPOSITORY_META_FILENAME]: {
        oldValue: oldMetaBuffer,
        newValue: newMetaBuffer,
      }
    },
  });

  if (repoMetaUpdateResult.newCommitHash) {
    await repositoriesChanged.main!.trigger({
      changedWorkingPaths: [workingCopyPath],
    });
    await repositoryBuffersChanged.main!.trigger({
      workingCopyPath,
      changedPaths: {
        [datasetMetaPath]: true,
        [PANERON_REPOSITORY_META_FILENAME]: true,
      },
    });
    return { success: true };
  } else {
    throw new Error("Recording dataset deletion failed to return a commit hash");
  }

});
