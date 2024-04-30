import log from 'electron-log';
import { removeSync, ensureDir } from 'fs-extra';
import nodePath from 'path';
//import * as R from 'ramda';
import levelup from 'levelup';
import leveldown from 'leveldown';
import encode from 'encoding-down';
import lexint from 'lexicographic-integer';
import type { CodecOptions } from 'level-codec';
import { throttle } from 'throttle-debounce';

import type { IndexStatus } from '@riboseinc/paneron-extension-kit/types/indexes';
import type { ChangeStatus } from '@riboseinc/paneron-extension-kit/types/changes';

import { getLoadedRepository } from 'repositories/main/loadedRepositories';
import { listDescendantPaths } from 'repositories/worker/buffers/list';
import { resolveDatasetAlias } from 'repositories/main/meta';
import { deposixifyPath } from '../../main/fs-utils';
import { joinPaths, makeQueue } from 'utils';
import { hash } from 'main/utils';
import type { API as Datasets, ReturnsPromise } from '../types';
import { filteredIndexUpdated, indexStatusChanged, objectsChanged } from '../ipc';
import { listObjectPaths } from './objects/list';
import { readObjectCold, readObjectVersions } from './objects/read';


/**
 * Keeps track of loaded datasets here in memory.
 *
 *     { datasetID: { objectPath: { field1: value1, ... }}}
 */
const datasets: {
  [workDir: string]: {
    [datasetID: string]: Datasets.Util.LoadedDataset
  }
} = {};

const datasetQueue = makeQueue();


// Main API

const load: Datasets.Lifecycle.Load =
datasetQueue.oneAtATime(async function loadDataset ({
  workDir,
  datasetID,
  cacheRoot,
}) {
  try {
    getLoadedDataset(workDir, datasetID);
    //log.silly("Datasets: Load: Already loaded", workDir, datasetID);

  } catch (e) {
    log.debug("Datasets: Load: Unloading to clean up", workDir, datasetID);

    await unloadDatasetDirect(workDir, datasetID);

    await loadDatasetDirect(workDir, datasetID, cacheRoot);

    log.info("Datasets: Load: Initialized dataset in-memory structure and default index", workDir, datasetID);
  }
}, ({ workDir, datasetID }) => [workDir, `${workDir}:${datasetID}`]);


async function loadDatasetDirect(workDir: string, datasetID: string, cacheRoot: string) {
  await ensureDir(cacheRoot);

  datasets[workDir] ||= {};
  datasets[workDir][datasetID] = {
    indexDBRoot: cacheRoot,
    indexes: {},
  };

  const msg = `Datasets: Load: Initializing default index for repo ${workDir} / dataset ${datasetID})`;
  log.info(msg);
  console.time(msg);

  await initDefaultIndex(
    workDir,
    datasetID,
  );

  console.timeEnd(msg);
}


const unload: Datasets.Lifecycle.Unload =
datasetQueue.oneAtATime(async function unloadDataset ({
  workDir,
  datasetID,
}) {
  try {
    await unloadDatasetDirect(workDir, datasetID);
    log.info("Datasets: Unloaded", workDir, datasetID);
  } catch (e) {
    log.warn("Problem unloading dataset", e, workDir, datasetID);
  }
}, ({ workDir, datasetID }) => [workDir, `${workDir}:${datasetID}`]);


const unloadAll: Datasets.Lifecycle.UnloadAll =
datasetQueue.oneAtATime(async function unloadAllDatasets ({
  workDir,
}) {
  if (!workDir) {
    for (const [workDir, workdirDatasets] of Object.entries(datasets)) {
      for (const datasetID of Object.keys(workdirDatasets)) {
        await unloadDatasetDirect(workDir, datasetID);
      }
    }
  } else {
    for (const datasetID of Object.keys(datasets[workDir] ?? {})) {
      await unloadDatasetDirect(workDir, datasetID);
    }
  }
}, ({ workDir }) => [workDir ?? '']);


/** Unloads given dataset without locking, does not throw but logs. */
async function unloadDatasetDirect(workDir: string, datasetID: string) {
  const ds = datasets[workDir]?.[datasetID] ?? null;

  if (!ds) { return; }

  for (const [idxID, { dbHandle, sortedDBHandle }] of Object.entries(ds?.indexes ?? {})) {
    try {
      await dbHandle.close();
    } catch (e) {
      log.error("Datasets: unload(): Failed to clear or close index DB handle", idxID, datasetID, workDir, e);
    }
    if (sortedDBHandle) {
      try {
        await sortedDBHandle.close();
      } catch (e) {
        log.error("Datasets: unload(): Failed to clear or close filtered index sorted DB handle", idxID, datasetID, workDir, e);
      }
    }
  }

  delete datasets[workDir]?.[datasetID];
}


async function clearIndexesAndReloadDatasetDirect(opts: { workDir: string, datasetID: string }) {
  const ds = getLoadedDataset(opts.workDir, opts.datasetID);
  const cacheRoot = ds.indexDBRoot;

  await unloadDatasetDirect(opts.workDir, opts.datasetID);

  removeSync(cacheRoot);

  await loadDatasetDirect(opts.workDir, opts.datasetID, cacheRoot);

}


// const clearIndexesAndReloadDataset =
// datasetQueue.oneAtATime(
//   clearIndexesAndReloadDatasetDirect,
//   ({ workDir, datasetID }) => [`${workDir}:${datasetID}`]);


const getOrCreateFilteredIndex: ReturnsPromise<Datasets.Indexes.GetOrCreateFiltered> =
datasetQueue.oneAtATime(async function getOrCreateFilteredIndex ({
  workDir,
  datasetID,
  queryExpression,
  keyExpression,
}) {
  const filteredIndexID = hash(queryExpression); // XXX

  let idx: null | Datasets.Util.FilteredIndex;

  try {

    idx = getFilteredIndex(
      workDir,
      datasetID,
      filteredIndexID,
    ) as Datasets.Util.FilteredIndex;

    //log.silly("Datasets: getOrCreateFilteredIndex: Already exists", queryExpression, filteredIndexID);

  } catch (e) {

    idx = null;

    log.debug(
      "Datasets: getOrCreateFilteredIndex: No good index found for predicate query expression, creating new:",
      queryExpression,
      filteredIndexID,
      e);
  }

  let valid: boolean = false;

  if (idx) {
    const commitHash = (await indexMeta(idx))?.commitHash;
    if (commitHash) {
      const defaultIndex = getDefaultIndex(workDir, datasetID);
      const defaultIndexHash = (await indexMeta(defaultIndex))?.commitHash;
      valid = defaultIndexHash === commitHash;
      if (!valid) {
        log.debug("Possibly stale filtered index found (commit hash differs from default index)", commitHash, 'vs default', defaultIndexHash);
      }
    } else {
      valid = false;
      log.debug("Broken filtered index: missing commit hash");
    }
    if (!valid) {
      await idx.dbHandle.clear();
      await idx.dbHandle.close();
      await idx.sortedDBHandle.clear();
      await idx.sortedDBHandle.close();
    }
  }

  if (!valid || !idx) {
    let predicate: Datasets.Util.FilteredIndexPredicate;
    try {
      predicate = new Function('objPath', 'obj', queryExpression) as Datasets.Util.FilteredIndexPredicate;
    } catch (e) {
      log.error("Unable to parse submitted predicate expression", queryExpression, e);
      throw new Error("Unable to parse submitted predicate expression");
    }

    let keyer: Datasets.Util.FilteredIndexKeyer | undefined;
    if (keyExpression) {
      try {
        keyer = new Function('obj', keyExpression) as Datasets.Util.FilteredIndexKeyer;
      } catch (e) {
        log.error("Unable to parse sorter expression", keyExpression, e);
        throw new Error("Unable to parse sorter expression");
      }
    } else {
      keyer = undefined;
    }

    idx = await initFilteredIndex(
      workDir,
      datasetID,
      filteredIndexID,
      predicate,
      keyer,
    );

    filteredIndexUpdated.main!.trigger({
      workingCopyPath: workDir,
      datasetID,
      indexID: filteredIndexID,
    });
  }

  return { indexID: filteredIndexID };
}, ({ workDir, datasetID, queryExpression }) => [`${workDir}:${datasetID}:${queryExpression}`]);


const describeIndex: ReturnsPromise<Datasets.Indexes.Describe> =
async function describeIndex ({
  workDir,
  datasetID,
  indexID,
}) {
  let idx: Datasets.Util.ActiveDatasetIndex<any>;
  if (indexID) {
    idx = getFilteredIndex(workDir, datasetID, indexID);
  } else {
    idx = getDefaultIndex(workDir, datasetID);
  }
  return {
    status: idx.status,
  };
}


const getFilteredObject: Datasets.Indexes.GetFilteredObject =
async function getFilteredObject ({
  workDir,
  datasetID,
  indexID,
  position,
}) {
  if (indexID === 'default') {
    throw new Error("Default index is not supported by getFilteredObject");
  }

  const idx = getFilteredIndex(
    workDir,
    datasetID,
    indexID) as Datasets.Util.FilteredIndex;
  const db = idx.sortedDBHandle;
  const objectPath = await db.get(position);

  return { objectPath };
}


const locatePositionInFilteredIndex: Datasets.Indexes.LocatePositionInFilteredIndex =
async function locatePositionInFilteredIndex ({
  workDir,
  datasetID,
  indexID,
  objectPath,
}) {
  if (indexID === 'default') {
    throw new Error("Default index is not supported by locatePositionInFilteredIndex");
  }

  const idx = getFilteredIndex(
    workDir,
    datasetID,
    indexID) as Datasets.Util.FilteredIndex;

  const db = idx.sortedDBHandle;

  for await (const data of db.createReadStream()) {
    const { key, value } = data as unknown as { key: number, value: string };
    if (value === objectPath) {
      return { position: key };
    }
  }

  throw new Error("Index position not found (probably given path doesn’t exist in the index)");
}


const resolveDatasetChanges: (opts: {
  /** Absolute path to Git working directory root. */
  workDir: string
  /** Dataset ID within the repository. */
  datasetID: string
  oidBefore: string
  oidAfter: string
}) => Promise<{
  /** Dataset-relative POSIX-style object paths. */
  changedObjectPaths: AsyncGenerator<string>,
}> = async function resolveDatasetChanges ({
  workDir,
  datasetID,
  oidBefore,
  oidAfter,
}) {
  const { workers: { sync } } = getLoadedRepository(workDir);

  // Find which buffers were added/removed/modified
  const { changedBuffers } = await sync.repo_resolveChanges({
    rootPath: resolveDatasetAlias(datasetID),
    oidBefore,
    oidAfter,
  });

  // Simply transforms the list of buffer paths to an async generator of strings.
  async function * getChangedPaths(changes: [ string, ChangeStatus ][]) {
    for (const [p, _] of changes) {
      yield p;
    }
  }

  const changedObjectPaths = listObjectPaths(getChangedPaths(changedBuffers));

  return { changedObjectPaths };
}


async function mapReduce(
  workDir: string,
  datasetID: string,
  predicate: Datasets.Util.PredicateFunction | undefined,
  map: Datasets.Util.MapFunction,
  reduce: Datasets.Util.ReduceFunction | undefined
): Promise<unknown> {
  const defaultIndex = getDefaultIndex(workDir, datasetID);
  // TODO: Shouldn’t we await completion in getDefaultIndex()?
  if (defaultIndex.completionPromise) {
    await defaultIndex.completionPromise;
  }
  const mappedData: unknown[] = [];
  function handleEmit(val: unknown) {
    mappedData.push(val);
  }
  //log.debug("mapReduce: mapping");
  for await (const data of defaultIndex.dbHandle.createReadStream()) {
    // TODO: [upstream] NodeJS.ReadableStream is poorly typed.
    const { key, value } = data as unknown as { key: string, value: Record<string, unknown> };
    if (key !== INDEX_META_MARKER_DB_KEY) {
      if (!predicate || predicate(key, value)) {
        map(key, value, handleEmit);
      }
    }
  }
  if (mappedData.length < 1) {
    return {};
  }
  if (reduce) {
    //log.debug("mapReduce: reducing", mappedData);

    // TODO: Provide initialValue, or otherwise work around the issue where
    // reduce() is not invoked when mappedData contains only one element.
    return mappedData.reduce((prev, curr) => reduce(prev, curr));
  } else {
    return mappedData;
  }
}


export default {
  load,
  unload,
  unloadAll,
  getOrCreateFilteredIndex,
  describeIndex,
  mapReduce,
  //streamIndexStatus,
  getFilteredObject,
  locatePositionInFilteredIndex,
};


/** Given paths, reads objects from filesystem into the index. */
async function _writeDefaultIndex(
  workDir: string,
  datasetID: string,
  index: Datasets.Util.DefaultIndex,
  changedObjectPathGenerator: AsyncGenerator<string>,
  statusReporter: (indexedItemCount: number) => void,
) {
  const datasetRoot = resolveDatasetAlias(datasetID);

  let loaded: number = 0;
  for await (const objectPath of changedObjectPathGenerator) {
    //log.debug("Datasets: updateDefaultIndex: Reading...", objectPath);
    //await new Promise((resolve) => setTimeout(resolve, 15));

    loaded += 1;
    statusReporter(loaded);

    let obj: Record<string, any> | null;
    try {
      obj = await readObjectCold(workDir, joinPaths(datasetRoot, objectPath));
    } catch (e) {
      // Pretend the object does not exist. readObjectCold() should log any deserialization errors.
      obj = null;
    }

    if (obj !== null) {
      await index.dbHandle.put(objectPath, obj);
      //log.debug("Datasets: updateDefaultIndex: Indexed", objectPath, obj ? Object.keys(obj) : null);
    } else {
      try {
        await index.dbHandle.del(objectPath);
        //log.debug("Datasets: updateDefaultIndex: Deleted", objectPath);
      } catch (e) {
        if ((e as any).type !== 'NotFoundError') {
          throw e;
        }
      }
    }
  }
}


// Utility functions


function getLoadedDataset(
  workDir: string,
  datasetID: string,
): Datasets.Util.LoadedDataset {
  const ds = datasets[workDir]?.[datasetID];
  if (!ds) {
    //log.warn("getLoadedDataset: is not loaded", datasetID);
    throw new Error("Dataset does not exist or is not loaded");
  }
  return ds;
}


// Indexes

/** Writes default index from scratch, by listing & reading objects from filesystem. */
async function fillInDefaultIndex(
  workDir: string,
  datasetID: string,
  index: Datasets.Util.DefaultIndex,
) {
  const datasetRoot = resolveDatasetAlias(datasetID);

  const defaultIndexStatusReporter = getDefaultIndexStatusReporter(workDir, datasetID);

  log.debug("Datasets: fillInDefaultIndex: Starting", workDir, datasetID);

  defaultIndexStatusReporter({
    objectCount: 0,
    progress: {
      phase: 'counting',
      total: 0,
      loaded: 0,
    },
  });

  function counterStatusReporter(counted: number) {
    defaultIndexStatusReporter({
      objectCount: counted,
      progress: {
        phase: 'counting',
        total: counted,
        loaded: 0,
      },
    });
  }
  const counterStatusReporterDebounced = throttle(100, true, counterStatusReporter);

  let totalCount: number = 0;

  if (index.completionPromise) {
    await index.completionPromise;
  }

  index.completionPromise = (async () => {
    await index.dbHandle.clear();

    await indexMeta(index, null);

    const repoCommit = await getCurrentCommit(workDir);

    // Collect object paths
    const objectPaths =
      listObjectPaths(listDescendantPaths(nodePath.join(workDir, deposixifyPath(datasetRoot))));

    for await (const objectPath of objectPaths) {
      counterStatusReporterDebounced(totalCount);
      await index.dbHandle.put(objectPath, false);
      totalCount += 1;
    }

    defaultIndexStatusReporter({
      objectCount: totalCount,
      progress: {
        phase: 'counting',
        total: totalCount,
        loaded: 0,
      },
    });

    log.debug("Datasets: fillInDefaultIndex: Read objects total", totalCount);

    async function * objectPathsToBeIndexed(): AsyncGenerator<string> {
      for await (const data of index.dbHandle.createReadStream()) {
        const { key, value } = data as unknown as { key: string, value: Record<string, any> | false };
        if (key !== INDEX_META_MARKER_DB_KEY && value === false) {
          yield key;
        }
      }
    }

    log.debug("Datasets: fillInDefaultIndex: Updating default index", workDir, datasetID);

    defaultIndexStatusReporter({
      objectCount: totalCount,
      progress: {
        phase: 'indexing',
        total: totalCount,
        loaded: 0,
      },
    });

    function loadedStatusReporter(loaded: number) {
      defaultIndexStatusReporter({
        objectCount: totalCount,
        progress: {
          phase: 'indexing',
          total: totalCount,
          loaded,
        },
      });
    }

    await _writeDefaultIndex(
      workDir,
      datasetID,
      index,
      objectPathsToBeIndexed(),
      throttle(100, true, loadedStatusReporter));

    await indexMeta(index, {
      completed: new Date(),
      commitHash: repoCommit,
      objectCount: totalCount,
    });

    defaultIndexStatusReporter({
      objectCount: totalCount,
    });

    index.completionPromise = undefined;

    return true as const;

  })();

  await index.completionPromise;
};


/** Fills in filtered index from scratch, by reading from default index. */
async function fillInFilteredIndex(
  defaultIndex: Datasets.Util.DefaultIndex,
  filteredIndex: Datasets.Util.FilteredIndex,
  statusReporter: (index: IndexStatus) => void,
) {
  const defaultIndexDB = defaultIndex.dbHandle;
  const predicate = filteredIndex.predicate;
  const keyer = filteredIndex.keyer;

  if (filteredIndex.completionPromise || defaultIndex.completionPromise) {
    await Promise.allSettled([
      filteredIndex.completionPromise,
      defaultIndex.completionPromise,
    ]);
  }

  filteredIndex.completionPromise = (async () => {
    const commitHash = (await indexMeta(defaultIndex))?.commitHash;

    if (!commitHash) {
      log.error("Datasets: fillInFilteredIndex: Default index doesn’t specify a commit hash, aborting");
      throw new Error("Unable to fill in filtered index: default index doesn’t specify a commit hash");
    }

    await indexMeta(filteredIndex, null);

    const total = defaultIndex.status.objectCount;

    log.debug("Datasets: fillInFilteredIndex: Operating on objects from default index", total);

    statusReporter({
      objectCount: 0,
      progress: {
        phase: 'indexing',
        total,
        loaded: 0,
      },
    });

    function updater(indexed: number, loaded: number) {
      statusReporter({
        objectCount: indexed,
        progress: {
          phase: 'indexing',
          total,
          loaded,
        },
      });
    }
    const updaterDebounced = throttle(100, true, updater);

    let indexed: number = 0;
    let loaded: number = 0;

    // First pass: write items into a temporary DB that orders on read
    const batch: { type: 'put', key: string, value: string }[] = [];
    for await (const data of defaultIndexDB.createReadStream()) {
      // TODO: [upstream] NodeJS.ReadableStream is poorly typed.
      const { key, value } = data as unknown as { key: string, value: Record<string, any> };
      if (key !== INDEX_META_MARKER_DB_KEY) {
        updaterDebounced(indexed, Math.floor(loaded));

        const objectPath: string = key;
        const objectData: Record<string, any> = value;

        //log.debug("Datasets: fillInFilteredIndex: Checking object", loaded * 2, objectPath, JSON.stringify((objectData || {}).id));
        //await new Promise((resolve) => setTimeout(resolve, 5));

        if (predicate(objectPath, objectData) === true) {
          //log.debug("Datasets: fillInFilteredIndex: Checking object using keyer", keyer);
          const customKey = (keyer ? keyer(objectData) : null) ?? objectPath;
          // If erroneous keyer implementation causes multiple objects to have the same key,
          // we go with unique object path
          const effectiveKey = batch.find(op => op.key === customKey)
            ? objectPath
            : customKey
          batch.push({
            type: 'put',
            key: effectiveKey,
            value: objectPath,
          });
          indexed += 1;
        }
        loaded += 0.5;
      }
    }
    await filteredIndex.dbHandle.batch(batch);

    await rebuildFilteredIndexSortedDB(
      filteredIndex,
      (item) => updaterDebounced(indexed, Math.floor(loaded + (item * 0.5))));

    await indexMeta(filteredIndex, {
      commitHash,
      completed: new Date(),
      objectCount: indexed,
    });

    filteredIndex.completionPromise = undefined;

    statusReporter({
      objectCount: indexed,
    });

    log.debug("Datasets: fillInFilteredIndex: Indexed vs. checked", indexed, loaded * 2);

    return true as const;
  })();

  await filteredIndex.completionPromise;
}


async function getCurrentCommit(workDir: string): Promise<string> {
  const { workers: { reader } } = getLoadedRepository(workDir);
  const { commitHash } = await reader.repo_getCurrentCommit({ workDir });
  return commitHash;
}


const initFilteredIndex = datasetQueue.oneAtATime(async function initFilteredIndex (
  workDir: string,
  datasetID: string,
  indexID: string,
  predicate: Datasets.Util.FilteredIndexPredicate,
  keyer?: Datasets.Util.FilteredIndexKeyer,
) {
  const ds = getLoadedDataset(workDir, datasetID);

  const cacheRoot = ds.indexDBRoot;

  const dbPath = getDBPath(cacheRoot, `${workDir}/${datasetID}/${indexID}`);
  const sortedDBPath = getDBPath(cacheRoot, `${workDir}/${datasetID}/${indexID}-sorted`);

  const indexStub = makeIdxStub(dbPath, {
    keyEncoding: 'string',
    valueEncoding: 'string',
  });

  const sortedDBHandle = levelup(encode(leveldown(sortedDBPath), {
    keyEncoding: {
      type: 'lexicographic-integer',
      encode: (n) => lexint.pack(n, 'hex'),
      decode: lexint.unpack,
      buffer: false,
    },
    valueEncoding: 'string',
  }));

  const idx: Datasets.Util.FilteredIndex = {
    ...indexStub,
    sortedDBHandle,
    accessed: new Date(),
    predicate,
    keyer,
  };

  datasets[workDir][datasetID].indexes[indexID] = idx;

  // NOTE: We are wiping the index here because it may be stale.
  // Filtered indexes are dynamically updated by iterating over ds.indexes populated at runtime as indexes are accessed,
  // and if an index is affected by an update but not yet accessed it’ll be stale.
  // However, once an index was initialized here and added under ds.indexes, it doesn’t need to be wiped,
  // since changes will be applied to it.
  //
  // The alternative (possibly a faster one) could be:
  // await fs.remove(dbPath);
  // await fs.remove(sortedDBPath);

  await idx.dbHandle.clear();
  await idx.sortedDBHandle.clear();

  const statusReporter = getFilteredIndexStatusReporter(workDir, datasetID, indexID);

  await fillInFilteredIndex(getDefaultIndex(workDir, datasetID), idx, statusReporter);

  return idx;

}, (workDir, datasetID, indexID) => [
  // Lock for entire dataset
  `${workDir}:${datasetID}`,
  `${workDir}:${datasetID}:${indexID}`,
]);


export function getFilteredIndex(
  workDir: string,
  datasetID: string,
  indexID: string,
): Datasets.Util.FilteredIndex {
  const ds = getLoadedDataset(workDir, datasetID);
  const idx = ds.indexes[indexID] as Datasets.Util.FilteredIndex | undefined;
  if (!idx) {
    //log.debug("Unable to get filtered index", datasetID, indexID)
    throw new Error("Unable to get filtered index");
  }
  return idx;
}


async function initDefaultIndex(
  workDir: string,
  datasetID: string,
): Promise<Datasets.Util.DefaultIndex> {
  const ds = getLoadedDataset(workDir, datasetID);
  const cacheRoot = ds.indexDBRoot;
  const dbPath = getDBPath(cacheRoot, `${workDir}/${datasetID}/default`);

  const idx: Datasets.Util.DefaultIndex = makeIdxStub(dbPath, {
    keyEncoding: 'string',
    valueEncoding: 'json',
  });

  datasets[workDir][datasetID].indexes['default'] = idx;

  try {
    const meta = await indexMeta(idx);
    const repoCommit = await getCurrentCommit(workDir);
    if (!meta || !meta.commitHash || !meta.completed || meta.commitHash !== repoCommit) {
      // Will proceed in the background:
      await fillInDefaultIndex(workDir, datasetID, idx);
    } else {
      idx.status = {
        objectCount: meta.objectCount,
      };
      getDefaultIndexStatusReporter(workDir, datasetID)(idx.status);
    }
  } catch (e) {
    log.error("Failed to initialize default index DB");
    throw e;
  }

  //idx.statusSubject.subscribe(status => {
  //  idx.status = status;
  //});
  return idx;
}

export function getDefaultIndex(
  workDir: string,
  datasetID: string,
): Datasets.Util.DefaultIndex {
  const ds = getLoadedDataset(workDir, datasetID);

  const idx = ds.indexes['default'] as Datasets.Util.DefaultIndex | undefined;

  if (!idx) {
    throw new Error("Unable to get default index");
  }

  return idx;
}


// Index status reporters.
// TODO: Make dataset index status reporters async?

function getFilteredIndexStatusReporter(workingCopyPath: string, datasetID: string, indexID: string) {
  const { indexes } = getLoadedDataset(workingCopyPath, datasetID);
  return function reportFilteredIndexStatus(status: IndexStatus) {
    indexes[indexID].status = status;
    indexStatusChanged.main!.trigger({
      workingCopyPath,
      datasetID,
      indexID,
      status,
    });
  }
}

function getDefaultIndexStatusReporter(workingCopyPath: string, datasetID: string) {
  const { indexes } = getLoadedDataset(workingCopyPath, datasetID);
  return function reportDefaultIndexStatus(status: IndexStatus) {
    indexes['default'].status = status;
    indexStatusChanged.main!.trigger({
      workingCopyPath,
      datasetID,
      status,
    });
  }
}


const INDEX_META_MARKER_DB_KEY: string = '**meta';

/** Fetch or update index metadata. */
async function indexMeta(
    idx: Datasets.Util.ActiveDatasetIndex<any>,
    newMeta?: Datasets.Util.IndexMeta | null,
): Promise<Datasets.Util.IndexMeta | null> {
  let meta: Datasets.Util.IndexMeta | null ;

  try {
    meta = (await idx.dbHandle.get(
      INDEX_META_MARKER_DB_KEY,
      { valueEncoding: 'json' },
    ) as Datasets.Util.IndexMeta | null) || null;
  } catch (e) {
    if ((e as any).type === 'NotFoundError') {
      meta = null;
    } else {
      throw e;
    }
  }

  if (newMeta !== undefined) {
    if (newMeta !== null) {
      await idx.dbHandle.put(
        INDEX_META_MARKER_DB_KEY,
        newMeta,
        { valueEncoding: 'json' });
    } else {
      try {
        await idx.dbHandle.del(INDEX_META_MARKER_DB_KEY);
      } catch (e) {}

    }
  }

  return meta || newMeta || null;
}


// TODO: implement `pruneUnusedFilteredIndexes()`, call it periodically to prevent filtered indexes from accumulating.
// async function pruneUnusedFilteredIndexes(ds: Datasets.Util.LoadedDataset) {
// }


/**
 * Updates default index and any affected filtered indexes. Notifies the UI.
 *
 * Index updates happen as follows:
 *
 * 1) file paths changed between current Git HEAD commit and commit stored in index DB are calculated
 * 2) for each changed path, depending on type of change,
 *    a record in default index is added/deleted/replaced with deserialized object data
 * 3) at the same time, if object data for that path matches any filtered index’s predicate,
 *    filtered index’s keyed DB is updated in the same way
 * 4) affected filtered indexes’ sorted DBs are rebuilt from their respective keyed DBs
 *
 * Once index is being rebuilt, further rebuilds are skipped until the update is complete.
 */
export const updateDatasetIndexesIfNeeded =
datasetQueue.oneAtATime(async function _updateDatasetIndexesIfNeeded (
  workDir: string,
  datasetID: string,
) {
  // TODO: Should concurrent index updates be skipped or queued?

  const ds = getLoadedDataset(workDir, datasetID);
  const affectedFilteredIndexes: { [idxID: string]: { idx: Datasets.Util.FilteredIndex, newObjectCount: number } } = {};
  const changes: Record<string, {
    oldObjectData?: unknown
    newObjectData?: unknown
    change: true | ChangeStatus
  }> = {};

  const defaultIndex = ds.indexes['default'];
  const defaultIdxDB = defaultIndex.dbHandle;

  const workers = getLoadedRepository(workDir).workers;

  //log.debug("updateDatasetIndexesIfNeeded: Starting");

  // Check current repository commit hash against default index’s stored commit hash.
  const { reader } = workers;
  const { commitHash: oidCurrent } = await reader.repo_getCurrentCommit({});
  const defaultIndexMeta = await indexMeta(defaultIndex);
  const oidIndex = defaultIndexMeta?.commitHash;

  // If default index has a commit hash in meta, and it matches repository commit hash, do nothing.
  if (oidIndex && oidIndex === oidCurrent) {
    log.warn("updateDatasetIndexesIfNeeded: not needed; commit hashes (index vs. HEAD)", oidIndex, oidCurrent);
    return;
  }

  if (!defaultIndexMeta || !oidIndex) {
    log.error("updateDatasetIndexesIfNeeded: Attempting to update dataset indexes, but default index lacks meta or commit hash");
    // TODO: Eventually we can have a single logic that either fills or updates index
    // but for now it’s separated across initial “filling in” and subsequent “updates”/“adjustments”
    throw new Error("Attempting to update dataset indexes, but default index lacks meta or commit hash");
  }

  // A list of all filtered index IDs will be useful soon.
  const filteredIndexes = Object.entries(ds.indexes).filter(([id, ]) => id !== 'default');
  const filteredIndexIDs: string[] = filteredIndexes.map(([id, ]) => id);

  const defaultIndexStatusReporter = getDefaultIndexStatusReporter(workDir, datasetID);

  //log.debug("updateDatasetIndexesIfNeeded: Operating on filtered indexes", filteredIndexes.map(([, idx]) => idx.predicate));

  const adjustIndex = (async function _adjustIndex () {

    // Otherwise, start the process by figuring out which files have changed between index & repo commits.

    //log.debug("updateDatasetIndexesIfNeeded: Figuring out what changed between", oidIndex, oidCurrent);

    const { changedObjectPaths } = await resolveDatasetChanges({
      workDir,
      datasetID,
      oidBefore: oidIndex,
      oidAfter: oidCurrent,
    });

    // First mark as undetermine changes,
    // later try to determine the nature of the change & adjust indexes
    for await (const objectPath of changedObjectPaths) {
      changes[objectPath] = { change: true };
    }

    //log.debug("updateDatasetIndexesIfNeeded: Processing object paths & updating indexes");

    defaultIndexStatusReporter({
      objectCount: defaultIndex.status.objectCount,
      progress: {
        phase: 'indexing',
        total: defaultIndex.status.objectCount,
        loaded: 0,
      },
    });

    let newDefaultIndexObjectCount = defaultIndexMeta.objectCount;

    let idx: number = 0;

    if (Object.keys(changes).length > 10) {
      throw new Error("Too many objects changed, skipping calculating difference");
    }

    // Update default index and infer which filtered indexes are affected
    for await (const objectPath of Object.keys(changes)) {
      idx += 1;
      const pathAffectsFilteredIndexes: {
        [id: string]: {
          idx: Datasets.Util.FilteredIndex,

          /** If false, the object does not match this filtered index now (but used to before). */
          newVersionMatches: boolean
        }
      } = {};

      // const readVersionsTimeMsg = `Resolving changes: reading versions of ${objectPath} at commits ${oidIndex!} & ${oidCurrent})`;
      // console.time(readVersionsTimeMsg);

      let objv1: Record<string, any> | null;
      let objv2: Record<string, any> | null;

      try {
        [objv1, objv2] = await readObjectVersions(
          workDir,
          datasetID,
          objectPath,
          // Read “before” and “after” object versions
          [oidIndex!, oidCurrent] as string[] & { length: 2 },
        );
      } catch (e) {
        [objv1, objv2] = [null, null];
      } finally {
        // console.timeEnd(readVersionsTimeMsg);
      }

      // const updateIndexesTimeMsg = `Resolving changes: updating filtered indexes (${filteredIndexIDs.length} total)`;
      // console.time(updateIndexesTimeMsg);

      //log.debug("Datasets: updateDatasetIndexesIfNeeded: Changed object path", objectPath, objv1, objv2);

      // Check all filtered indexes that have not yet been marked as affected
      for (const idxID of filteredIndexIDs) {
        const idx = ds.indexes[idxID] as Datasets.Util.FilteredIndex;
        // If one or another object version matches given filtered index’s predicate,
        // mark that index as affected and track object count changes.
        // TODO: Notify frontend about filtered index status.
        const oldVersionMatched = (objv1 && idx.predicate(objectPath, objv1)) ? true : false;
        const newVersionMatches = (objv2 && idx.predicate(objectPath, objv2)) ? true : false;
        if ((oldVersionMatched || newVersionMatches) && newVersionMatches !== oldVersionMatched) {
          //log.debug("Datasets: updateDatasetIndexesIfNeeded: Path affects filtered indexes", objectPath, idxID)
          pathAffectsFilteredIndexes[idxID] = {
            idx,
            newVersionMatches,
          };
          // Check if we already marked this index as affected
          // while processing a previous object path…
          if (!affectedFilteredIndexes[idxID]) {
            // If not, we get existing meta pointer.
            const meta = await indexMeta(idx);
            if (meta) {
              // Notify frontend that the index is being updated.
              indexStatusChanged.main!.trigger({ workingCopyPath: workDir, datasetID, indexID: idxID, status: {
                objectCount: meta.objectCount,
                progress: {
                  phase: 'counting',
                  // These are placeholders,
                  // this code doesn’t estimate progress yet:
                  loaded: 0,
                  total: 1,
                },
              } });
              // Keep track of affected indexes and their object counts here.
              affectedFilteredIndexes[idxID] = {
                idx,
                newObjectCount: meta.objectCount,
              };
            } else {
              log.warn("Datasets: updateDatasetIndexesIfNeeded: Filtered index is missing metadata");
              // Currently, we just skip updating an index without meta,
              // but we could either fill it in from scratch (asynchronously)
              // or delete it and have the front-end recreate it.
            }
          }
        }
      }

      // Update or delete structured object data in default index,
      // update keys/paths in filtered indexes
      if (objv2 !== null) { // Object was changed or added

        // Add/update object data in default index
        await defaultIdxDB.put(objectPath, objv2);
        if (objv1 === null) { // Object was added
          //log.debug("Datasets: updateDatasetsIndexesIfNeeded: Added object path", objectPath);
          changes[objectPath] = { change: 'added', newObjectData: objv2 };

          // Add object path in affected filtered indexes
          for (const [idxID, { idx }] of Object.entries(pathAffectsFilteredIndexes)) {
            const customKey = (idx.keyer ? idx.keyer(objv2) : null) ?? objectPath;
            await idx.dbHandle.put(customKey, objectPath);
            affectedFilteredIndexes[idxID].newObjectCount += 1;
          }
          newDefaultIndexObjectCount += 1;
          defaultIndexStatusReporter({
            objectCount: defaultIndex.status.objectCount + 1,
            progress: {
              phase: 'indexing',
              total: defaultIndex.status.objectCount,
              loaded: idx,
            },
          });
        } else { // Object was changed
          //log.debug("Datasets: updateDatasetsIndexesIfNeeded: Changed object path", objectPath);
          changes[objectPath] = { newObjectData: objv2, change: 'modified' };

          // Add new key (or object path) to affected filtered indexes,
          // delete old key (if it’s different) from affected filtered indexes
          for (const [idxID, { idx, newVersionMatches }] of Object.entries(pathAffectsFilteredIndexes)) {
            // Key corresponding to version before
            const customKey1 = (idx.keyer ? idx.keyer(objv1) : null) ?? objectPath;
            // Key corresponding to version after
            const customKey2 = (idx.keyer ? idx.keyer(objv2) : null) ?? objectPath;
            if (customKey2 !== customKey1) {
              try {
                await idx.dbHandle.del(customKey1);
              } catch (e) {}
            }
            if (newVersionMatches) {
              await idx.dbHandle.put(customKey2, objectPath);
              affectedFilteredIndexes[idxID].newObjectCount += 1;
            } else {
              try {
                await idx.dbHandle.del(customKey2);
              } catch (e) {}
              affectedFilteredIndexes[idxID].newObjectCount -= 1;
            }
          }
          defaultIndexStatusReporter({
            objectCount: defaultIndex.status.objectCount,
            progress: {
              phase: 'indexing',
              total: defaultIndex.status.objectCount,
              loaded: idx,
            },
          });
        }
      } else { // Object was likely deleted, or never existed
        //log.debug("Datasets: updateDatasetsIndexesIfNeeded: Removed object path", objectPath);
        try {
          changes[objectPath] = { oldObjectData: objv1, change: 'removed' };

          // Delete from default index
          try {
            await defaultIdxDB.del(objectPath);
            newDefaultIndexObjectCount -= 1;
            defaultIndexStatusReporter({
              objectCount: defaultIndex.status.objectCount - 1,
              progress: {
                phase: 'indexing',
                total: defaultIndex.status.objectCount,
                loaded: idx,
              },
            });
          } catch (e) {}

          if (objv1) {
            // If it previously existed, delete key or object path from affected filtered indexes.
            for (const [idxID, { idx }] of Object.entries(pathAffectsFilteredIndexes)) {
              const customKey = (idx.keyer ? idx.keyer(objv1) : null) ?? objectPath;
              try {
                await idx.dbHandle.del(customKey);
                affectedFilteredIndexes[idxID].newObjectCount -= 1;
              } catch (e) {}
            }
          }
        } catch (e) {
          if ((e as any).type === 'NotFoundError') {
            // (or even never existed)
            changes[objectPath] = { change: true };
          } else {
            throw e;
          }
        }
      }

      // console.timeEnd(updateIndexesTimeMsg);
    }

    // Update default & filtered index meta; rebuild filtered index sorted DBs

    console.time("Rebuilding filtered indexes")
    await indexMeta(defaultIndex, { commitHash: oidCurrent, completed: new Date(), objectCount: newDefaultIndexObjectCount });
    for (const { idx, newObjectCount } of Object.values(affectedFilteredIndexes)) {
      await indexMeta(idx, { commitHash: oidCurrent, completed: new Date(), objectCount: newObjectCount });
      await rebuildFilteredIndexSortedDB(idx);
    }
    console.timeEnd("Rebuilding filtered indexes");

    return true as const;
  });

  // The above process should be fast, but may affect any index…
  // If any index is busy for whatever reason, await completion first.
  await Promise.allSettled(Object.values(ds.indexes).
    filter(idx => idx.completionPromise ? true : false).
    map(idx => idx.completionPromise));

  // Start the work
  const completionPromise = adjustIndex();

  // Assign completion promise to indicate all indices are busy
  defaultIndex.completionPromise = completionPromise;
  for (const idxID of filteredIndexIDs) {
    ds.indexes[idxID].completionPromise = completionPromise;
  }

  try {
    // Await completion
    await completionPromise;

    // Notify frontend
    defaultIndexStatusReporter({
      objectCount: defaultIndex.status.objectCount,
    });

    objectsChanged.main!.trigger({
      workingCopyPath: workDir,
      datasetID,
      objects: changes,
    });

    for (const [indexID, { newObjectCount }] of Object.entries(affectedFilteredIndexes)) {
      ds.indexes[indexID].status.objectCount = newObjectCount;
      filteredIndexUpdated.main!.trigger({ workingCopyPath: workDir, datasetID, indexID });
      indexStatusChanged.main!.trigger({ workingCopyPath: workDir, datasetID, indexID, status: {
        objectCount: newObjectCount,
      } });
    }

  } catch (e) {
    // It’s possible that resolveDatasetChanges bailed. Let’s just reload.

    log.error("Failed to adjust indexes; clearing & reloading", e);

    await clearIndexesAndReloadDatasetDirect({ workDir, datasetID });

    // Notify frontend anyway

    objectsChanged.main!.trigger({
      workingCopyPath: workDir,
      datasetID,
      objects: undefined,
    });

    for (const indexID of filteredIndexIDs) {
      filteredIndexUpdated.main!.trigger({ workingCopyPath: workDir, datasetID, indexID });
    }

    // Is throwing going to offend any caller?
    //throw e;

  } finally {
    // Clear completion promises

    defaultIndex.completionPromise = undefined;
    for (const idxID of filteredIndexIDs) {
      ds.indexes[idxID].completionPromise = undefined;
    }
  }
}, (workDir, datasetID) => [`${workDir}:${datasetID}`]);


/** Drops and rebuilds filtered index sorted DB from its keyed DB. */
async function rebuildFilteredIndexSortedDB(
  idx: Datasets.Util.FilteredIndex,
  onItem?: (obj: number) => void,
) {
  await idx.sortedDBHandle.clear();
  let position: number = 0;
  const batch = idx.sortedDBHandle.batch();
  for await (const data of idx.dbHandle.createReadStream()) {
    const { key, value } = data as unknown as { key: string, value: string };
    if (key !== INDEX_META_MARKER_DB_KEY) {
      //log.debug("Indexing sorted key", position, key, value);
      batch.put(position, value);

      onItem?.(position);
      position += 1;
    }
  }
  await batch.write();
}


// Utility functions

function getDBPath(cacheRoot: string, id: string) {
  return nodePath.join(cacheRoot, hash(id));
}


function makeIdxStub(dbPath: string, codecOptions: CodecOptions):
Datasets.Util.ActiveDatasetIndex<any> {
  const idx: Datasets.Util.ActiveDatasetIndex<any> = {
    status: { objectCount: 0 },
    //statusSubject: new Subject<IndexStatus>(),
    dbHandle: levelup(encode(leveldown(dbPath), codecOptions)),
    accessed: new Date(),
  };

  return idx;
}
