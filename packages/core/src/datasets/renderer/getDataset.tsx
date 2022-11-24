import fs from 'fs-extra';
import path from 'path';
import log from 'electron-log';
import React from 'react';
import { PluginManager } from 'live-plugin-manager';
import { RendererPlugin, DatasetContext } from '@riboseinc/paneron-extension-kit/types';
import {
  getPluginManagerProps,
  installPlugin,
  listLocalPlugins,
  removePlugin,
} from 'plugins';
import { describeRepository, loadRepository } from 'repositories/ipc';
import { DatasetInfo } from '../types';
import { getDatasetInfo, loadDataset } from '../ipc';


export default async function getDataset(workingCopyPath: string, datasetID: string): Promise<{
  writeAccess: boolean;
  dataset: DatasetInfo;
  MainView: React.FC<DatasetContext & { className?: string }>;
  getObjectView: RendererPlugin["getObjectView"];
}> {

  if (workingCopyPath === '') {
    throw new Error("Invalid repository working copy path");
  }

  let MainView: React.FC<DatasetContext & { className?: string }>;
  let writeAccess: boolean;
  let dataset: DatasetInfo;
  let getObjectView: RendererPlugin["getObjectView"];

  let pluginManager: PluginManager;
  let pluginID: string;
  let pluginVersion: string | undefined;

  // Prepare plugin info and manager
  try {
    await loadRepository.renderer!.trigger({ workingCopyPath });
    const [repoInfo, datasetInfo, pluginManagerProps] = await Promise.all([
      describeRepository.renderer!.trigger({ workingCopyPath }),
      getDatasetInfo.renderer!.trigger({ workingCopyPath, datasetID }),
      getPluginManagerProps.renderer!.trigger({}),
    ]);

    const _gitRepoInfo = repoInfo.result?.info.gitMeta;
    const _datasetInfo = datasetInfo.result?.info;

    if (!_gitRepoInfo) {
      throw new Error("This does not seem to be a Paneron repository");
    }
    if (!_datasetInfo) {
      throw new Error("This does not seem to be a Paneron dataset");
    }

    const _pluginID = _datasetInfo.type.id;
    const cwd = pluginManagerProps.result?.cwd;
    const pluginsPath = pluginManagerProps.result?.pluginsPath;

    if (!_pluginID) {
      throw new Error("Dataset does not specify type");
    }
    if (!pluginsPath || !cwd) {
      throw new Error("Error configuring extension manager");
    }

    writeAccess = _gitRepoInfo.remote === undefined || _gitRepoInfo.remote.writeAccess === true;
    dataset = _datasetInfo;

    pluginManager = new PluginManager({ cwd, pluginsPath });
    pluginID = _pluginID;

    // NOTE: We’ll always install latest extension version. Extension should maintain backwards compatibility.
    // TODO: Take into account dataset schema version and install latest extension version still compatible with specified schema version?
    // pluginVersion = _datasetInfo.type.version;
    pluginVersion = undefined;

  } catch (e) {
    log.error("Failed to get extension ID or load extension manager", e);
    throw e;
  }

  const pluginName = pluginID; // TODO: DRY


  // let pluginPath: string | undefined;
  // Install plugin in renderer
  try {
    // NOTE: This requires `nodeIntegration` to be true on Electron’s window.
    // Ideally, we want to get rid of that.
    const { result: localPlugins } = await listLocalPlugins.renderer!.trigger({});

    if (!localPlugins[pluginName]?.localPath) {
      log.silly("Dataset view: Installing plugin for renderer...", workingCopyPath, pluginName, pluginVersion);
      const { version } = await pluginManager.installFromNpm(pluginName, pluginVersion);
      await installPlugin.renderer!.trigger({ id: pluginName, version });

    } else {
      const localPath = localPlugins[pluginName].localPath!;
      const version = localPlugins[pluginName].npm.version;

      log.silly("Dataset view: (Re)installing plugin for renderer (local)...", workingCopyPath, pluginName, localPath, pluginVersion);

      const pluginLocation = (
        pluginManager.getInfo(pluginName)?.location ??
        path.join(
          pluginManager.options.pluginsPath,
          pluginName.split(path.posix.sep).join(path.sep)));

      // Clean up the plugin in filesystem
      log.debug("Dataset view: Removing plugin from FS", pluginLocation);
      if (pluginLocation) {
        if (pluginLocation.startsWith(pluginManager.options.pluginsPath)) {
          try {
            fs.removeSync(pluginLocation);
          } catch (e) {
            log.debug("Dataset view: Removing plugin from FS: error", e);
          }
        } else {
          throw new Error("Can’t remove plugin (plugin path is not a descendant of root plugin path)");
        }
      }

      await pluginManager.uninstall(pluginName);
      await removePlugin.renderer!.trigger({ id: pluginName });

      await installPlugin.renderer!.trigger({ id: pluginName, version });
      await pluginManager.installFromPath(localPath);
    }

    // pluginPath = pluginManager.getInfo(pluginName)?.location;
  } catch (e) {
    log.error("Dataset view: Error installing plugin for renderer", workingCopyPath, pluginName, pluginVersion, e);
    throw new Error("Error loading extension");
  }

  // if (!pluginPath) {
  //   log.error("Repository view: Cannot get plugin path");
  //   throw new Error("Cannot get extension module file path");
  // }
  // Require plugin
  try {
    log.silly("Dataset view: Requiring renderer plugin...", pluginName);
    const pluginPromise: RendererPlugin = pluginManager.require(pluginName).default;

    // Experiment with using plain remote did not work so well so far.
    //const pluginPromise: RendererPlugin = global.require(path.resolve(`${pluginPath}/plugin`)).default;
    log.silly("Dataset view: Awaiting renderer plugin...", pluginPromise);

    // IMPORTANT: VS Code may report await as unnecessary, but it is very much required.
    // Could be due to broken typings in live-plugin-manager.
    const plugin = await pluginPromise;

    if (!plugin.mainView) {
      log.error("Dataset view: Not provided by plugin", pluginName, pluginVersion, plugin.mainView);
      throw new Error("Error requesting main dataset view from Paneron extension");
    }

    MainView = plugin.mainView;
    getObjectView = plugin.getObjectView;
    log.silly("Dataset view: Got renderer plugin and dataset view", plugin);

    log.silly("Dataset view: Loading dataset…");
    const dataset = (await loadDataset.renderer!.trigger({
      workingCopyPath,
      datasetID,
    })).result;
    if (!dataset || !dataset.success) {
      throw new Error("Unable to load dataset");
    }

  } catch (e) {
    log.error("Dataset view: Error requiring plugin", workingCopyPath, pluginName, pluginVersion, e);
    throw e;
  }

  return { MainView, writeAccess, dataset, getObjectView };
}