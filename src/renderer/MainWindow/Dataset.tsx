/** @jsx jsx */
/** @jsxFrag React.Fragment */

//import log from 'electron-log';
import { jsx, css } from '@emotion/react';
import { useContext, useCallback, useEffect, useState, useMemo } from 'react';
import React from 'react';
import { Helmet } from 'react-helmet';
import MathJax from 'react-mathjax2';
import { FormGroup, Button, Radio, RadioGroup, Icon, IconSize, Classes, NonIdealState, Spinner } from '@blueprintjs/core';

import HelpTooltip from '@riboseinc/paneron-extension-kit/widgets/HelpTooltip';
import type { RendererPlugin, DatasetContext } from '@riboseinc/paneron-extension-kit/types';
import OperationQueueContext from '@riboseinc/paneron-extension-kit/widgets/OperationQueue/context';
import type { Exporter, ExportOptions, ExportFormatInfo } from '@riboseinc/paneron-extension-kit/types/export-formats';

import { ZipArchive } from '../../renderer/zip/ZipArchive';
import { stripLeadingSlash } from '../../utils';

import { getBufferDataset, getBufferPaths } from 'repositories/ipc';
import { unloadDataset } from 'datasets/ipc';
import getDataset from 'datasets/renderer/getDataset';
import { getFullAPI } from 'datasets/renderer/context';
import type { DatasetInfo } from 'datasets/types';
import { getPluginInfo } from 'plugins';
import ErrorBoundary from '../common/ErrorBoundary';
import { Context } from './context';


const NODE_MODULES_PATH = process.env.NODE_ENV === 'production'
  ? `${__static}/../../app.asar.unpacked/node_modules`
  : `${__static}/../../node_modules`;

const MATHJAX_PATH = `${NODE_MODULES_PATH}/mathjax/MathJax.js?config=TeX-MML-AM_CHTML-full`;

const MATHJAX_PATH_WITH_PROTO = `file://${MATHJAX_PATH}`;

const MATHJAX_OPTS = {
  asciimath2jax: {
    useMathMLspacing: true,
    delimiters: [["`","`"]],
    preview: "none",
  },
  tex2jax: {
    inlineMath: [['$','$'], ['\\(','\\)']],
    processEscapes: true
  },
} as const;

//const toaster = Toaster.create({ position: 'bottom-left', canEscapeKeyClear: false });


const Dataset: React.FC<{ className?: string; showExportOptions?: true }> =
function ({ className, showExportOptions }) {
  const { state: { selectedRepoWorkDir, selectedDatasetID }, dispatch } = useContext(Context);
  const { performOperation, isBusy } = useContext(OperationQueueContext);
  const [isLoading, setLoading] = useState(false);
  const [dsProps, setDatasetProperties] = useState<{
    writeAccess: boolean;
    dataset: DatasetInfo;
    MainView: React.FC<DatasetContext & { className?: string }>;
    exportFormats: RendererPlugin["exportFormats"],
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await performOperation('loading dataset', async () => {
          if (cancelled) { return };
          if (selectedRepoWorkDir && selectedDatasetID) {
            setLoading(true);
            try {
              const dsProps = await getDataset(selectedRepoWorkDir, selectedDatasetID);
              if (cancelled) { return };
              setDatasetProperties(dsProps);
            } finally {
              if (cancelled) { return };
              setLoading(false);
            }
          } else {
            setLoading(false);
            setDatasetProperties(null);
          }
        }, { blocking: true })();
      } catch (e) {
        dispatch({ type: 'close-dataset' });
      }
    })();
    return function cleanup() {
      cancelled = true;
      if (selectedRepoWorkDir && selectedDatasetID) {
        unloadDataset.renderer!.trigger({
          workingCopyPath: selectedRepoWorkDir,
          datasetID: selectedDatasetID,
        });
      }
    }
  }, [selectedRepoWorkDir, selectedDatasetID]);

  const dsAPI = useMemo((() => selectedRepoWorkDir && selectedDatasetID && dsProps
    ? getFullAPI({
        workingCopyPath: selectedRepoWorkDir,
        datasetID: selectedDatasetID,
        writeAccess: dsProps.writeAccess,
        exportFormats: dsProps.exportFormats,
        performOperation,
      })
    : null
  ), [performOperation, selectedDatasetID, selectedRepoWorkDir, dsProps]);

  const ctx: DatasetContext | null =
  useMemo((() => dsAPI && dsProps
    ? {
        ...dsAPI,
        title: dsProps.dataset.title,
        isBusy,
        performOperation,
      }
    : null
  ), [isBusy, dsProps, dsAPI, performOperation]);

  // TODO: Move out exporting to a separate view

  const exportGit: (opts: ExportOptions) => Exporter = useCallback(async function* _exportGit () {
    if (!selectedRepoWorkDir || !selectedDatasetID) {
      throw new Error("No repository or dataset");
    }
    // List ALL buffer paths in the dataset at once (!)
    const { result: { bufferPaths } } = await getBufferPaths.renderer!.trigger({
      workingCopyPath: selectedRepoWorkDir,
      prefix: selectedDatasetID,
    });
    // Yield buffer dataset per chunk of paths.
    for (let i = 0; i < bufferPaths.length; i+= 10) {
      const bufferPathChunk = bufferPaths.slice(i, i + 10).
        map(p => `${selectedDatasetID}/${stripLeadingSlash(p)}`);
      const { result } = await getBufferDataset.renderer!.trigger({
        workingCopyPath: selectedRepoWorkDir,
        paths: bufferPathChunk,
      });
      console.debug("Got buffer dataset", result);
      yield result;
    }
  }, [selectedRepoWorkDir, selectedDatasetID]);

  const handleExport = useCallback(async function handleExport(formatID: string): Promise<string> {
    if (!dsProps || !ctx) {
      throw new Error("Dataset is not ready");
    }
    if (!ctx.writeFileToFilesystem) {
      throw new Error("Capability to export to filesystem is not available");
    }
    const exporter = formatID === GIT_EXPORT_FORMAT_ID
      ? exportGit
      : dsProps?.exportFormats[formatID]?.exporter;
    if (!exporter) {
      throw new Error(`No exporter ${formatID}`);
    }
    const zip = new ZipArchive();
    const datasetGenerator = exporter({
      getObjectData: ctx.getObjectData,
      getMapReducedData: ctx.getMapReducedData,
    });
    for await (const _ds of datasetGenerator) {
      for (const [_fp, _buf] of Object.entries(_ds)) {
        if (_buf !== null) {
          await zip.set(stripLeadingSlash(_fp), new Blob([_buf]));
        }
      }
    }
    const opts = {
      dialogOpts: {
        prompt: "Select where to save exported data",
        filters: [{
          name: "ZIP arhcive",
          extensions: ['zip'],
        }],
      },
      bufferData: new Uint8Array((await zip.to_blob().arrayBuffer())),
    };
    const { savedToFileAtPath } = await ctx.writeFileToFilesystem(opts);
    return savedToFileAtPath;
  }, [ctx, exportGit, dsProps]);

  const exportFormats = {
     ...(ctx?.listExporters() ?? {}),
     ...DEFAULT_EXPORT_FORMATS,
  };

  const view = ctx && dsProps && selectedRepoWorkDir && selectedDatasetID
    ? showExportOptions
      ? <ExportOptions
          datasetInfo={dsProps.dataset}
          exportFormats={exportFormats}
          inProgress={isBusy}
          onCancel={() => dispatch({ type: 'close-dataset' })}
          onRequestExport={isBusy
            ? undefined
            : ctx.performOperation('exporting', handleExport, { blocking: true })}
        />
      : <ErrorBoundary viewName="dataset">
          <dsProps.MainView {...ctx} />
        </ErrorBoundary>
    : isLoading
      ? <NonIdealState
          icon={<Spinner />}
          description={<>This should take a few seconds<br />Please make sure you’re online</>}
        />
      : <NonIdealState icon="heart-broken" description="Unable to load dataset" />;

  return (
    <MathJax.Context
        script={MATHJAX_PATH_WITH_PROTO}
        options={MATHJAX_OPTS}>
      <div css={css`display: flex; flex-flow: row nowrap;`} className={className}>
        <Helmet>
          <title>{ctx?.title ?? selectedDatasetID} (dataset)</title>
        </Helmet>
        {view}
      </div>
    </MathJax.Context>
  );
}


const GIT_EXPORT_FORMAT_ID = 'git' as const;
const DEFAULT_EXPORT_FORMATS = {
  [GIT_EXPORT_FORMAT_ID]: {
    name: "Source data, as is",
    description: "Full source data. NOTE: Prefer to clone the corresponding Git repository instead. This may take a while.",
  },
} as const;


const DEFAULT_PLUGIN_INFO = { plugin: null } as const;


const ExportOptions: React.FC<{
  datasetInfo: DatasetInfo
  exportFormats: { [formatID: string]: ExportFormatInfo }
  onRequestExport?: (formatID: string) => void
  onCancel?: () => void
  inProgress?: boolean
}> = function ({ datasetInfo, exportFormats, onRequestExport, onCancel, inProgress }) {
  const [formatID, setFormatID] = useState<undefined | string>(undefined);

  const { value: { plugin } } = getPluginInfo.renderer!.useValue(
    { id: datasetInfo.type.id ?? '' },
    DEFAULT_PLUGIN_INFO);

  const effectiveIconEl: JSX.Element = !plugin
    ? <Icon icon="circle" size={IconSize.LARGE * 4} />
    : !plugin?.iconURL
      ? <Icon icon="heart-broken" />
      : <Icon
          icon={<img className={Classes.ICON}
            css={css`height: ${IconSize.LARGE * 4}px; width: ${IconSize.LARGE * 4}px`}
            src={plugin?.iconURL} />}
        />;

  const canExport = !!(!inProgress && onRequestExport && formatID);

  return <NonIdealState
    icon={effectiveIconEl}
    title={`Export dataset ${datasetInfo.title}`}
    description={<div css={css`text-align: left;`}>
      <FormGroup label="Available export formats:">
        <RadioGroup
            onChange={evt => setFormatID(evt.currentTarget.value)}
            selectedValue={formatID}>
          {Object.entries(exportFormats).map(([formatID, formatInfo]) =>
            <Radio
                key={formatID}
                disabled={!onRequestExport}
                value={formatID}
                labelElement={<>
                  {formatInfo.name}
                  {formatInfo.description.trim()
                    ? <>&ensp;<HelpTooltip content={formatInfo.description} /></>
                    : undefined}
                </>} />
          )}
        </RadioGroup>
      </FormGroup>
      <FormGroup helperText={<>
        This will generate a ZIP archive with exported data,
        after which you will be prompted for a location to write the file to.
      </>}>
        <Button
            large
            fill
            icon='export'
            intent={canExport ? 'primary' : undefined}
            onClick={() => onRequestExport?.(formatID ?? '')}
            loading={inProgress}
            disabled={!canExport}>
          Export
        </Button>
      </FormGroup>
      <Button disabled={inProgress} onClick={onCancel}>
        Cancel
      </Button>
    </div>}
  />;
};


export default Dataset;
