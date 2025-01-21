/** @jsx jsx */
/** @jsxFrag React.Fragment */

//import { throttle } from 'throttle-debounce';
import formatDistance from 'date-fns/formatDistance';

import { useThrottledCallback } from 'use-debounce';

import React, { memo, useState, useMemo, useCallback, useEffect } from 'react';
import { jsx } from '@emotion/react';
import type { ToastProps } from '@blueprintjs/core';

import { loadRepository, unloadRepository, loadedRepositoryStatusChanged } from 'repositories/ipc';
import { describeRepository, repositoryBuffersChanged } from 'repositories/ipc';
import type { RepoStatus } from 'repositories/types';

import { Breadcrumb, type BreadcrumbProps } from './Breadcrumb';
import RepositorySummary from '../repositories/TooltipSummary';


const initialStatus: RepoStatus = { busy: { operation: 'initializing' } };


export const RepoBreadcrumb: React.FC<{
  workDir: string
  onNavigate?: () => void
  onClose?: () => void
  onMessage: (opts: ToastProps) => void
}> = memo(function ({ workDir, onNavigate, onClose, onMessage }) {

  const initialRepoDescription = useMemo((() => ({
    info: {
      gitMeta: {
        workingCopyPath: workDir,
        mainBranch: '',
      },
    },
    isLoaded: false,
  })), [workDir]);

  const openedRepoResp = describeRepository.renderer!.useValue({
    workingCopyPath: workDir,
  }, initialRepoDescription);

  const repoInfo = openedRepoResp.value.info;

  repositoryBuffersChanged.renderer!.useEvent(async ({ workingCopyPath }) => {
    if (workingCopyPath === workDir) {
      openedRepoResp.refresh();
    }
  }, [workDir]);

  const originalRepoStatus = loadRepository.renderer!.useValue({
    workingCopyPath: workDir,
  }, initialStatus);

  const [_status, setStatus] = useState<RepoStatus | null>(null);

  // Merging status lets us preserve the error message from previous status
  // with progress information.
  const mergeStatus = useCallback(function mergeStatus (newStatus) {
    setStatus(_status => {
      const shouldMerge = _status?.status && ['ahead', 'behind', 'diverged'].indexOf(_status?.status ?? '') >= 0;
      return {
        ...newStatus,
        status: !newStatus.status && shouldMerge ? _status.status : newStatus.status,
        remoteHead: newStatus.remoteHead ?? (_status as any)?.remoteHead,
      }
    });
  }, [setStatus]);

  const mergeStatusThrottled = useThrottledCallback(
    mergeStatus,
    300,
    { leading: true, trailing: true });

  // NOTE: We started relying exclusively on status updates being throttled
  // in the worker thread. One reason for that is that we need to
  // throttle *only consecutive* “busy” progress updates: the first “busy”
  // must trigger setStatus, as we rely on it e.g. to set latest sync timestamp
  // in GUI.
  //const setStatus = useMemo(() => throttle(50, setStatus, false), [workDir]);

  const status = _status ?? originalRepoStatus.value;
  const isLoaded = _status?.status !== 'unloaded' ?? openedRepoResp.value.isLoaded;

  loadedRepositoryStatusChanged.renderer!.useEvent(async ({ workingCopyPath, status }) => {
    if (workingCopyPath === workDir) {
      mergeStatusThrottled(status);
    }
  }, [workDir, mergeStatusThrottled]);

  const [lastSyncTS, setLastSyncTS] = useState<Date | null>(null);
  const [timeSinceLastSync, setTimeSinceLastSync] = useState<string>('');

  useEffect(() => {
    const interval = setInterval(
      (() =>
        lastSyncTS
          ? setTimeSinceLastSync(formatDistance(new Date(), lastSyncTS, { includeSeconds: true }))
          : void 0
      ),
      888);
    return function cleanup() { clearInterval(interval); };
  }, [workDir, lastSyncTS]);

  useEffect(() => {
    return function cleanup() {
      unloadRepository.renderer!.trigger({ workingCopyPath: workDir });
    }
  }, [workDir]);

  const [progress, error]: [BreadcrumbProps["progress"], true | string | undefined] =
  useMemo(() => {
    let progress: BreadcrumbProps["progress"];
    let error: true | string | undefined;
    if (status.busy) {
      switch (status.busy?.operation) {

        // Only these operations can provide specific progress info
        case 'uploading to LFS':
        case 'pushing':
        case 'pulling':
        case 'cloning':
          setLastSyncTS(new Date());
          if (status.busy.awaitingPassword) {
            progress = { phase: "Awaiting credentials" };
            error = "Unable to authenticate — please check stored access credentials in repository settings";
          } else {
            progress = status.busy.progress
              ? { ...status.busy.progress, phase: `${status.busy.operation}: ${status.busy.progress.phase}` }
              : { phase: status.busy.operation };
            error = status.busy.networkError
              ? "Possible networking issue"
              : undefined;
          }
          break;

        // For the rest, show indeterminate progress
        default:
          progress = { phase: `Operation: ${status.busy.operation}…` };
          error = undefined;
      }
    } else {
      progress = undefined;
      error = !isLoaded ? "Repository is not loaded" : undefined;
    }

    if (!error && status.status === 'diverged') {
      error = "Upstream repository has diverged, can’t merge with your changes automatically";
    }

    return [progress, error]
  }, [isLoaded, status]);

  const statusString = !progress || error
    ? <>
        {isLoaded ? "Loaded" : "Not loaded"}
        {status.status ? ` — status: ${status.status ?? 'N/A'}` : null}
        {`, local commit: ${(status as any).localHead?.slice(0, 6) ?? '(N/A)'}`}
        {timeSinceLastSync ? ` — ${timeSinceLastSync} since last sync attempt` : null}
      </>
    : null;

  return (
    <Breadcrumb
      title={
        (
          repoInfo.paneronMeta?.title ??
            repoInfo.gitMeta.workingCopyPath.slice(
              repoInfo.gitMeta.workingCopyPath.length - 20,
              repoInfo.gitMeta.workingCopyPath.length)
        ) + (typeof repoInfo.gitMeta?.label === 'string'
          ? ` (${repoInfo.gitMeta?.label})`
          : ''
        )
      }
      icon={ICON_PROPS}
      onClose={onClose}
      onNavigate={onNavigate}
      status={<>
        {statusString}
        <RepositorySummary repo={repoInfo} />
      </>}
      progress={progress}
      error={error}
    />
  );
});


const ICON_PROPS = { type: 'blueprint', iconName: 'git-repo' } as const;


export default RepoBreadcrumb;
