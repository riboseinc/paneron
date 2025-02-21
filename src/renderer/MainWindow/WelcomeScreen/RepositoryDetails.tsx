/** @jsx jsx */
/** @jsxFrag React.Fragment */

import React, { useCallback, useContext, useEffect, useState } from 'react';
import { jsx, css } from '@emotion/react';
import { Menu, MenuDivider, NonIdealState, Panel, Colors, PanelStack2, Spinner } from '@blueprintjs/core';
import { MenuItem2 as MenuItem } from '@blueprintjs/popover2';

import OperationQueueContext from '@riboseinc/paneron-extension-kit/widgets/OperationQueue/context';

import {
  addDisconnected,
  describeRepository,
  repositoryBuffersChanged,
  repositoriesChanged,
  setLabel,
} from 'repositories/ipc';
import { type Repository, SOLE_DATASET_ID } from 'repositories/types';
import RepositorySettings from './RepositorySettings';
import RepoLabel from './RepoLabel';
import InitializeDataset from './InitializeDataset';
import DatasetMenuItem from './DatasetMenuItem';

import { repoMetaDatasets } from '../../../datasets/util';


const RepositoryDetails: React.FC<{
  workDir: string;
  onOpen: (datasetID: string) => void;
  onExport?: (datasetID: string) => void;
}> =
function ({ workDir, onOpen, onExport }) {
  const openedRepoResp = describeRepository.renderer!.useValue(
    { workingCopyPath: workDir },
    { info: { gitMeta: { workingCopyPath: workDir, mainBranch: '' } }, isLoaded: false });

  const { performOperation, isBusy } = useContext(OperationQueueContext);

  const repo = openedRepoResp.value.info;

  repositoryBuffersChanged.renderer!.useEvent(async ({ workingCopyPath }) => {
    if (workingCopyPath === workDir) {
      openedRepoResp.refresh();
    }
  }, [workDir]);

  repositoriesChanged.renderer!.useEvent(async ({ changedWorkingPaths }) => {
    if ((changedWorkingPaths ?? []).indexOf(workDir) >= 0) {
      openedRepoResp.refresh();
    }
  }, [workDir]);

  // useEffect(() => {
  //   // If this repository has remote connected, load repository in order to sync
  //   if (repo.gitMeta.remote?.url) {
  //     console.debug("Loading repository to sync with remote", workDir, repo.gitMeta.remote?.url);
  //     loadRepository.renderer!.trigger({ workingCopyPath: workDir });
  //   } else {
  //     console.debug("Not loading repository (no remote connected?)", workDir, repo.gitMeta.remote?.url);
  //   }
  // }, [JSON.stringify(repo.gitMeta.remote?.url)]);

  const repoSettingsPanel: Panel<RepoSettingsProps> = {
    title: "Settings",
    renderPanel: () => <RepositorySettings
      workDir={workDir}
      repoInfo={repo}
      css={css`overflow-y: auto; flex: 1; padding: 10px;`}
    />,
    props: {},
  };

  const createDatasetPanel: Panel<CreateDatasetProps> = {
    title: "Initialize new dataset",
    renderPanel: () => <InitializeDataset workDir={workDir} />,
    props: {},
  };

  const handleRepoLabelEdit = performOperation(
    'updating repository label',
    async function _handleRepoLabelEdit (label: string | undefined) {
      await setLabel.renderer!.trigger({ workingCopyPath: workDir, label });
    },
  );

  const [panel, setPanel] = useState<Panel<CreateDatasetProps | RepoSettingsProps> | null>(null);

  const repoMenuPanel: Panel<RepoMenuProps> = {
    title: <RepoLabel repo={repo} onEdit={!isBusy && !panel ? handleRepoLabelEdit : undefined} />,
    props: {
      repo: repo,
      onOpenDataset: onOpen,
    },
    renderPanel: ({ repo, onOpenDataset, closePanel, openPanel }) => <RepoMenu
      repo={repo}
      onOpenDataset={onOpenDataset}
      onExportDataset={onExport}
      onOpenSettings={() => openPanel(repoSettingsPanel)}
      onCreateDataset={() => openPanel(createDatasetPanel)} />,
  };

  useEffect(() => {
    setPanel(null);
  }, [JSON.stringify(repo)]);

  const handleClosePanel = useCallback(() => {
    setPanel(null);
  }, []);

  const panelStack: Panel<any>[] = !panel
    ? [repoMenuPanel]
    : [repoMenuPanel, panel];

  if (repo) {
    return (
      <PanelStack2
        stack={panelStack}
        onClose={handleClosePanel}
        onOpen={setPanel}
        css={css`
          position: absolute;
          inset: 0;
          .bp4-dark & .bp4-panel-stack-view {
            background: ${Colors.DARK_GRAY1};
          }
        `}
      />
    );
  } else if (openedRepoResp.isUpdating) {
    return <NonIdealState icon={<Spinner />} />;
  } else {
    return <NonIdealState icon="heart-broken" description="Repository failed to load" />;
  }
};

interface CreateDatasetProps {
}
interface RepoSettingsProps {
}
interface RepoMenuProps {
  repo: Repository;
  onOpenDataset?: (datasetID: string) => void;
  onExportDataset?: (datasetID: string) => void;
  onOpenSettings?: () => void;
  onCreateDataset?: () => void;
}
const RepoMenu: React.FC<RepoMenuProps> = function ({
  repo,
  onOpenDataset,
  onExportDataset,
  onOpenSettings,
  onCreateDataset,
}) {
  const { workingCopyPath: workDir } = repo.gitMeta;

  const { performOperation, isBusy } = useContext(OperationQueueContext);

  const makePrivateCopy = repo.gitMeta.remote && !isBusy
    ? performOperation('making private working copy', async () => {
        repo.gitMeta.remote
          ? await addDisconnected.renderer!.trigger({
              gitRemoteURL: repo.gitMeta.remote.url,
              username: repo.gitMeta.remote.username,
              branch: repo.gitMeta.mainBranch,
            })
          : void 0;
      })
    : () => void 0;

  const publishingToRemote = repo.gitMeta.remote?.writeAccess === true;
  const fetchingChanges = repo.gitMeta.remote && repo.gitMeta.remote?.writeAccess !== true;
  const sharingMenu = publishingToRemote
    ? <>
        <MenuItem
          text="Remote connected"
          icon="cloud"
          disabled />
        <MenuItem
          text="Make a disconnected offline copy"
          title="This will create a separate repository, offline and local to this computer only. Good for experiments and tests (but note that registers currently do not support creating proposals in offline repositories)."
          onClick={makePrivateCopy}
          icon="lab-test" />
      </>
    : fetchingChanges
      ? <MenuItem
          text="Remote connected (fetching only)"
          icon="cloud-download"
          disabled />
      : null;

  const settingsMenuItem: JSX.Element = (
    <MenuItem
      text="Repository settings"
      icon="settings"
      onClick={onOpenSettings}
      disabled={!onOpenSettings} />
  );

  if (repo.paneronMeta && (repo.paneronMeta.datasets || repo.paneronMeta.dataset)) {

    const datasetIDs = repo.paneronMeta.datasets
      ? repoMetaDatasets(repo.paneronMeta.datasets)
      : [SOLE_DATASET_ID];

    return (
      <Menu css={css`.bp4-dark & { background: ${Colors.DARK_GRAY1}; }`}>
        <MenuDivider title="Datasets" />

        {datasetIDs.map(dsID =>
          <DatasetMenuItem
            key={dsID}
            workDir={workDir}
            datasetID={dsID}
            onClick={onOpenDataset ? () => onOpenDataset!(dsID) : undefined}
            onExportClick={onExportDataset ? () => onExportDataset!(dsID) : undefined}
          />
        )}

        <MenuItem
          text="Create new dataset"
          icon="add"
          onClick={onCreateDataset}
          disabled={!onCreateDataset} />

        <MenuDivider />

        {settingsMenuItem}
        {sharingMenu}

      </Menu>
    );
  } else {
    return <>
      <NonIdealState
        icon="heart-broken"
        description="This does not appear to be a Paneron repository." />
      <Menu>
        {settingsMenuItem}
      </Menu>
    </>
  }

};


export default RepositoryDetails;
