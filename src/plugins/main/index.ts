import rax from 'retry-axios';
import _axios from 'axios';

import { app } from 'electron';
import log from 'electron-log';

import fs from 'fs-extra';
import path from 'path';

import compareDesc from 'date-fns/compareDesc';
import parseJSON from 'date-fns/parseJSON';

import { spawn, Worker, Thread } from 'threads';
import {
  getPluginInfo, getPluginManagerProps,
  getPackageCode,
  installPlugin, listAvailablePlugins,
  listLocalPlugins,
  pluginsUpdated, removeLocalPluginPath, removePlugin, specifyLocalPluginPath, upgradePlugin,
} from '../../plugins';
import type { Extension, ExtensionRegistry, MaybeLocalExtension } from '../../plugins/types';
import type { Methods as WorkerMethods, WorkerSpec } from './worker';


const axios = _axios.create({ timeout: 6000 });
axios.defaults.raxConfig = {
  instance: axios,
  noResponseRetries: 1,
};
rax.attach(axios);


listAvailablePlugins.main!.handle(async () => {
  const packages = await fetchExtensions();

  const extensions: MaybeLocalExtension[] = Object.entries(packages).
  sort(([_0, ext1], [_1, ext2]) => compareDesc(parseJSON(ext1.latestUpdate), parseJSON(ext2.latestUpdate))).
  map(([_, ext]) => ext);

  return {
    extensions,
  };
});


installPlugin.main!.handle(async ({ id, version: versionToInstall }) => {
  const name = id;

  try {
    await _installPlugin(name, versionToInstall);
  } finally {
    await pluginsUpdated.main!.trigger({
      changedIDs: [id],
    });
  }

  return { installed: true };
});


removePlugin.main!.handle(async ({ id }) => {
  await _removePlugin(id);
  await pluginsUpdated.main!.trigger({
    changedIDs: [id],
  });
  return { success: true };
});


upgradePlugin.main!.handle(async ({ id, version: versionToUpgradeTo }) => {
  const name = id;

  try {
    await _removePlugin(name);
  } catch (e) {
    log.error("Plugins: Upgrade: Error when uninstalling", id)
  }

  try {
    await _installPlugin(name, versionToUpgradeTo);
  } finally {
    await pluginsUpdated.main!.trigger({
      changedIDs: [id],
    });
  }

  return { installed: true };
});


getPackageCode.main!.handle(async ({ id, version }) => {
  const w = await worker;
  const localPlugins = await w.listLocalPlugins();
  const localPath = localPlugins[id]?.localPath;
  // For now, we only load new-style extensions if locally installed
  if (!localPath) {
    throw new Error("Extension is not locally installed");
  }

  const builtFilePath = path.join(localPath, 'extension.js');

  log.debug("getPackageCode: getting code from", builtFilePath);

  const code = await fs.readFile(builtFilePath, { encoding: 'utf-8' });

  return { code };
});


getPluginInfo.main!.handle(async ({ id }) => {
  const name = id;

  if (!name) {
    return { plugin: null };
  }

  const w = await worker;

  const localPlugins = await w.listLocalPlugins();

  const ext: Extension | undefined = localPlugins[id] ?? (await fetchExtensions())[name]

  if (ext) {
    const isLocal = localPlugins[id] ? true : undefined;
    try {
      const { installedVersion } = await w.getInstalledVersion({ name });
      return { plugin: { ...ext, installedVersion, isLocal } };
    } catch (e) {
      log.error("Unable to fetch information about installed extension version", name);
      return { plugin: { ...ext, installedVersion: null, isLocal } };
    }
  } else {
    log.error("Plugins: Cannot locate extension (not local, not in Paneron extension index)", name);
    return { plugin: null };
  }
});


getPluginManagerProps.main!.handle(async () => {
  return {
    cwd: CWD,
    pluginsPath: PLUGINS_PATH,
  };
});


// Local plugins

specifyLocalPluginPath.main!.handle(async ({ directoryPath }) => {
  const ext = await (await worker).specifyLocalPluginPath({ directoryPath });
  await _removePlugin(ext.npm.name);
  await pluginsUpdated.main!.trigger({});
  return ext;
});

removeLocalPluginPath.main!.handle(async ({ pluginName }) => {
  await _removePlugin(pluginName);
  const result = await (await worker).removeLocalPlugin({ pluginName });
  await pluginsUpdated.main!.trigger({});
  return result;
});

listLocalPlugins.main!.handle(async () => {
  return await (await worker).listLocalPlugins();
});


// (Un)installation helpers

async function _installPlugin(name: string, versionToInstall?: string): Promise<void> {
  const w = await worker;
  (await w.install({ name, version: versionToInstall }));
  return;
}


async function _removePlugin(name: string): Promise<true> {
  (await (await worker).remove({ name }));
  return true;
}


// Plugin manager

const CWD = app.getPath('userData');
const PLUGINS_PATH = path.join(CWD, 'plugins');
const PLUGIN_CONFIG_PATH = path.join(CWD, 'plugin-config.yaml');

function clearLockfile() {
  log.debug("Plugins: Clearing lockfile");
  fs.removeSync(path.join(PLUGINS_PATH, 'install.lock'));
}

export async function clearPluginData() {
  clearLockfile();

  // Clear cached extensions
  for (const key of Object.keys(publishedExtensions)) {
    delete publishedExtensions[key];
  }

  fs.removeSync(PLUGINS_PATH);
  fs.removeSync(PLUGIN_CONFIG_PATH);
}

clearLockfile();
app.on('quit', clearLockfile);



// Querying extension directory

// Fetch them once per app launch and cache them here
const publishedExtensions: ExtensionRegistry = {};

async function fetchPublishedExtensions(ignoreCache?: true): Promise<ExtensionRegistry> {
  if (ignoreCache || Object.keys(publishedExtensions).length < 1) {
    try {
      const ext = (await axios.get("https://extensions.paneron.org/extensions.json")).data.extensions;
      Object.assign(publishedExtensions, ext);
    } catch (e) {
      log.error("Plugins: Unable to fetch published extensions", (e as any).message ?? 'unknown error');
    }
  }
  return publishedExtensions;
}

async function fetchExtensions(): Promise<ExtensionRegistry> {
  const publishedExtensions = await fetchPublishedExtensions();
  const localExtensions = await (await worker).listLocalPlugins();
  return {
    ...publishedExtensions,
    ...localExtensions,
  };
}



// Worker

export const worker: Promise<Thread & WorkerMethods> = new Promise((resolve, reject) => {
  log.debug("Plugins: Spawning worker");

  spawn<WorkerSpec>(new Worker('./worker')).
  then((worker) => {
    log.debug("Plugins: Spawning worker: Done");

    async function terminateWorker() {
      log.debug("Plugins: Terminating worker");
      await Thread.terminate(worker);
    }

    app.on('quit', terminateWorker);

    Thread.events(worker).subscribe(evt => {
      if (evt.type === 'internalError') {
        log.error("Plugins: Worker error:", evt);
      } else if (evt.type === 'termination') {
        log.warn("Plugins: Worker termination:", evt);
      }
      // TODO: Respawn on worker exit?
    });

    log.debug("Plugins: Initializing worker", CWD, PLUGINS_PATH, PLUGIN_CONFIG_PATH);

    worker.initialize({
      pluginsPath: PLUGINS_PATH,
      pluginConfigPath: PLUGIN_CONFIG_PATH,
    }).
    then(() => {
      log.debug("Plugins: Init: Worker initialized");
      resolve(worker);
    }).
    catch(reject);
  }).
  catch(reject);
});
