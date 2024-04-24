import type { ObjectDataset } from '@riboseinc/paneron-extension-kit/types/objects';

import type {
  OpenFileDialogProps,
  SelectDirectoryProps,
  SaveFileDialogProps,
} from '@riboseinc/paneron-extension-kit/types/dialogs';

import { type EmptyPayload, makeEndpoint, _ } from './ipc';


export const CLEAR_OPTIONS = [
  'ui-state',
  //'db-indexes',
  'plugins',
  //'settings',
  'repositories',
] as const;

export type ClearOption = typeof CLEAR_OPTIONS[number];


export const getAppVersion = makeEndpoint.main(
  'getAppVersion',
  <EmptyPayload>_,
  <{ version: string, isPackaged?: boolean }>_,
);


export const getColorScheme = makeEndpoint.main(
  'getColorScheme',
  <EmptyPayload>_,
  <{ colorSchemeName: string }>_,
);


export const colorSchemeUpdated = makeEndpoint.renderer(
  'colorSchemeUpdated',
  <{ colorSchemeName: string }>_,
);


export const clearDataAndRestart = makeEndpoint.main(
  'clearDataAndRestart',
  <{ options: Record<ClearOption, boolean> }>_,
  <{ success: true }>_,
);


/** Prompts user for a file and returns file data as object dataset. */
export const chooseFileFromFilesystem = makeEndpoint.main(
  'chooseFileFromFilesystem',
  <OpenFileDialogProps>_,
  <ObjectDataset>_,
);


export const selectDirectoryPath = makeEndpoint.main(
  'selectDirectoryPath',
  <SelectDirectoryProps>_,
  <{ directoryPath?: string }>_,
);


/** Opens an external URL using OS native mechanism. */
export const openExternalURL = makeEndpoint.main(
  'openExternalURL',
  <{ url: string }>_,
  <EmptyPayload>_,
);


export const saveFileToFilesystem = makeEndpoint.main(
  'saveFileToFilesystem',
  <{ dialogOpts: SaveFileDialogProps, bufferData: Uint8Array | DataView }>_,
  <{ success: true, savedToFileAtPath: string }>_,
);


export const makeRandomID = makeEndpoint.main(
  'makeRandomID',
  <EmptyPayload>_,
  <{ id: string }>_,
);


/** Sent from main thread when global (host app) settings screen is requested via menu. */
export const showGlobalSettings = makeEndpoint.renderer(
  'showGlobalSettings',
  <EmptyPayload>_,
);


/** Triggered when global (host app) settings screen is requested. */
export const refreshMainWindow = makeEndpoint.main(
  'refreshMainWindow',
  <EmptyPayload>_,
  <EmptyPayload>_,
);
