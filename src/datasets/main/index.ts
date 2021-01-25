import { ensureDir } from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { app } from 'electron';
import log from 'electron-log';
import {
  deleteDataset,
  getDatasetInfo,
  initializeDataset,
  loadDataset,
  proposeDatasetPath,
  getObjectDataset,
} from 'datasets';
import { readPaneronRepoMeta, readRepoConfig } from 'main/repositories';
import repoWorker from 'main/repositories/workerInterface';
import cache from 'main/repositories/cache';
import { requireMainPlugin } from 'main/plugins';
import { checkPathIsOccupied, forceSlug } from 'utils';
import {
  PANERON_REPOSITORY_META_FILENAME,

  // TODO: Define a more specific datasets changed event
  repositoriesChanged,
  repositoryBuffersChanged,
} from 'repositories';

import { DATASET_FILENAME, readDatasetMeta } from './util';

import './migrations';


getDatasetInfo.main!.handle(async ({ workingCopyPath, datasetPath }) => {
  try {
    return { info: await readDatasetMeta(workingCopyPath, datasetPath) };
  } catch (e) {
    return { info: null };
  }
});


proposeDatasetPath.main!.handle(async ({ workingCopyPath, datasetPath }) => {
  if (!datasetPath) {
    throw new Error("Single-dataset repositories are not currently supported.");
  }

  const dir = forceSlug(datasetPath);
  const fullPath = path.join(workingCopyPath, dir);

  // For check to succeed, the path must not exist at all.
  // TODO: We could accept empty directory, but would vave to validate it’s absolutely empty.
  const isOccupied = await checkPathIsOccupied(fullPath);

  if (isOccupied) {
    return { path: undefined };
  } else {
    return { path: dir };
  }
});


const encoder = new TextEncoder();


initializeDataset.main!.handle(async ({ workingCopyPath, meta: datasetMeta, datasetPath }) => {
  if (!datasetPath) {
    throw new Error("Single-dataset repositories are not currently supported");
  }

  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Repository configuration is missing author information");
  }

  const plugin = await requireMainPlugin(
    datasetMeta.type.id,
    datasetMeta.type.version);
  const initialMigration = await plugin.getInitialMigration();
  const initialMigrationResult = await initialMigration.default({
    datasetRootPath: path.join(workingCopyPath, datasetPath),
    onProgress: (msg) => log.debug("Migration progress:", msg),
  });

  const repoMeta = await readPaneronRepoMeta(workingCopyPath);
  const newRepoMeta = {
    ...repoMeta,
    datasets: {
      ...(repoMeta.datasets || {}),
      [datasetPath]: true,
    },
  };

  const repoMetaBuffer =
    encoder.encode(yaml.dump(repoMeta, { noRefs: true }));
  const newRepoMetaBuffer =
    encoder.encode(yaml.dump(newRepoMeta, { noRefs: true }));

  const repos = await repoWorker;

  const datasetMetaPath = path.join(datasetPath, DATASET_FILENAME);
  const migrationChangeset = initialMigrationResult.bufferChangeset;

  const { newCommitHash } = await repos.repo_updateBuffers({
    workDir: workingCopyPath,
    commitMessage: `Initialize dataset at ${datasetPath}`,
    author,
    bufferChangeset: {
      [datasetMetaPath]: {
        oldValue: null,
        newValue: encoder.encode(yaml.dump(datasetMeta, { noRefs: true })),
      },
      [PANERON_REPOSITORY_META_FILENAME]: {
        oldValue: repoMetaBuffer,
        newValue: newRepoMetaBuffer,
      },
      ...migrationChangeset,
    },
  });

  if (newCommitHash) {
    await cache.invalidatePaths({
      workingCopyPath,
    });
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


loadDataset.main!.handle(async ({ workingCopyPath, datasetPath }) => {
  const dataset = await readDatasetMeta(workingCopyPath, datasetPath);
  const plugin = await requireMainPlugin(dataset.type.id);

  const migration = plugin.getMigration(dataset.type.version);
  if (migration) {
    // Having encountered an error while loading the dataset,
    // GUI is expected to query the outstanding migration
    // using another IPC endpoint, and prompt the user to apply it (yet another IPC endpoint).
    throw new Error("Dataset migration is required");
  }

  const objectSpecs = plugin.getObjectSpecs();
  const cacheRoot = path.join(app.getPath('userData'), 'index-dbs');

  log.debug("Datasets: Load: Ensuring cache root dir…", cacheRoot);

  await ensureDir(cacheRoot);

  log.debug("Datasets: Load: Registering object specs…", objectSpecs);

  (await repoWorker).ds_load({
    workDir: workingCopyPath,
    datasetDir: datasetPath,
    objectSpecs,
    cacheRoot,
  });

  log.debug("Datasets: Load: Registering object specs… Done");

  // TODO: Build custom indexes, if any, here
  // const dbDirName = crypto.createHash('sha1').
  //   update(`${path.join(workingCopyPath, datasetPath)}\n${yaml.dump(dataset, { noRefs: true })}`).
  //   digest('hex');
  // const dbPath = path.join(app.getPath('userData'), dbDirName);
  // await plugin.buildIndexes(workingCopyPath, datasetPath, dbDirName);

  return { success: true };
});


getObjectDataset.main!.handle(async ({ workingCopyPath, datasetPath, objectPaths }) => {
  const data = await (await repoWorker).ds_getObjectDataset({
    workDir: workingCopyPath,
    datasetDir: datasetPath,
    objectPaths,
  });
  return { data };
});


deleteDataset.main!.handle(async ({ workingCopyPath, datasetPath }) => {
  const w = await repoWorker;

  const { author } = await readRepoConfig(workingCopyPath);
  if (!author) {
    throw new Error("Missing author information in repository config");
  }

  const repoMeta = await readPaneronRepoMeta(workingCopyPath);
  if (!repoMeta.datasets?.[datasetPath]) {
    throw new Error("Dataset is not found in Paneron repository meta");
  }

  // To ensure we are deleting a Paneron dataset
  await readDatasetMeta(workingCopyPath, datasetPath);

  const deletionResult = await w.repo_deleteTree({
    workDir: workingCopyPath,
    commitMessage: `Delete dataset at ${datasetPath}`,
    author,
    treeRoot: datasetPath,
  });

  if (!deletionResult.newCommitHash) {
    throw new Error("Failed while deleting dataset object tree");
  }

  const oldMetaBuffer = encoder.encode(yaml.dump(repoMeta, { noRefs: true }));
  delete repoMeta.datasets[datasetPath];
  const newMetaBuffer = encoder.encode(yaml.dump(repoMeta, { noRefs: true }));

  const repoMetaUpdateResult = await w.repo_updateBuffers({
    workDir: workingCopyPath,
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
    return { success: true };
  } else {
    throw new Error("Recording dataset deletion failed to return a commit hash");
  }

});
