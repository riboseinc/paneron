/** @jsx jsx */
/** @jsxFrag React.Fragment */

import { css, jsx } from '@emotion/react';
import React, { useContext, useState } from 'react';
import { ButtonGroup } from '@blueprintjs/core';

import OperationQueueContext from '@riboseinc/paneron-extension-kit/widgets/OperationQueue/context';

import { getNewRepoDefaults, savePassword, setRemote, unsetRemote, unsetWriteAccess } from 'repositories/ipc';
import type { GitRepository } from 'repositories/types';

import { Button } from '../../widgets';
import GitCredentialsInput from './GitCredentialsInput';
import ButtonWithPrompt from '../../common/ButtonWithPrompt';


export const ShareRepoForm: React.FC<{ repo: GitRepository }> =
function ({ repo }) {
  const { performOperation, isBusy } = useContext(OperationQueueContext);
  const defaults = getNewRepoDefaults.renderer!.useValue({}, { defaults: { author: { name: '', email: '' } } });

  const [_url] = useState('');
  const [customUsername, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [editingPassword, setEditingPassword] = useState(false);

  const username = ((customUsername || repo.remote?.username) ?? defaults.value.defaults?.remote?.username ?? '').trim();
  const url = _url.trim() || repo.remote?.url?.trim() || '';

  const hasRemote = repo.remote !== undefined;

  const canShare =
    hasRemote === false &&
    !isBusy &&
    (username ?? '').trim() !== '' &&
    (password ?? '') !== '' &&
    (url ?? '').trim() !== '';

  const canUnshare = hasRemote === true && !isBusy;

  async function _savePassword() {
    if (hasRemote) {
      await savePassword.renderer!.trigger({
        workingCopyPath: repo.workingCopyPath,
        remoteURL: url,
        username: username,
        password: password ?? '',
      });
      setEditingPassword(false);
      setPassword('');
    }
  }

  async function turnOffPush() {
    if (repo.remote?.writeAccess) {
      await unsetWriteAccess.renderer!.trigger({
        workingCopyPath: repo.workingCopyPath,
      });
    }
  }

  async function share() { if (canShare) {
      try {
        await setRemote.renderer!.trigger({
          workingCopyPath: repo.workingCopyPath,
          url,
          username,
          password,
        });
      } catch (e) {
        throw new Error("Please check that this URL points to an empty repository, your username has push access, password/token (if needed) is correct, and your Internet connection is online.");
      }
    }
  }

  async function unshare() {
    if (canUnshare) {
      await unsetRemote.renderer!.trigger({
        workingCopyPath: repo.workingCopyPath,
      });
    }
  }

  return (
    <>
      <ButtonGroup vertical fill css={css`margin-bottom: 5px; height: unset !important;`}>
      {hasRemote
        ? <>
            <ButtonWithPrompt
                promptIntent="warning"
                promptMessage={<>
                  Before turning off relaying changes, make sure you don’t have any outstanding changes.
                  If you turn off relaying changes (“push”), you will continue to receive others’ changes;
                  but if you will want to start making changes later, you would have to delete
                  and re-add this repository.
                </>}
                small
                outlined
                disabled={isBusy || repo.remote?.writeAccess !== true}
                onClick={performOperation('turning off push', turnOffPush)}>
              {repo.remote?.writeAccess ? "Stop relaying changes" : "Your changes are not relayed"}
            </ButtonWithPrompt>

            <ButtonWithPrompt
                onClick={performOperation('turning off sync and unsetting remote', unshare)}
                small
                outlined
                disabled={isBusy || !canUnshare}
                promptIntent="warning"
                promptMessage={<>
                  The only way to re-enable sync for now is by removing and re-adding the repository anew.
                  If you turn off sync, you will remain being able to make changes, but those changes will stay on this computer.
                </>}>
              Clear remote &amp; stop sync
            </ButtonWithPrompt>

            {editingPassword
              ? <ButtonGroup>
                  <Button small fill outlined disabled={isBusy} onClick={performOperation('updating password', _savePassword)}>
                    {password !== ''
                      ? 'Save secret'
                      : 'Reset saved secret'}
                  </Button>
                  <Button small fill outlined disabled={isBusy} onClick={() => { setEditingPassword(false); setPassword(''); }}>
                    Don’t save
                  </Button>
                </ButtonGroup>
              : <Button fill small outlined disabled={isBusy} active={editingPassword} onClick={() => setEditingPassword(true)}>
                  Amend secret
                </Button>}
          </>
        : <Button small outlined
              disabled={isBusy || !canShare}
              title="To start sharing, configure empty repository URL and access credentials below."
              onClick={performOperation('starting sync with remote', share)}>
            Connect remote &amp; start sync
          </Button>}
      </ButtonGroup>

      <GitCredentialsInput
        username={username}
        password={password}
        remoteURL={url || ''}
        requireMainBranchName={repo.mainBranch}
        onEditPassword={!isBusy && (!hasRemote || editingPassword) ? setPassword : undefined}
        onEditUsername={!isBusy && !hasRemote ? setUsername : undefined}
        requireBlankRepo={!hasRemote}
        requirePush
      />
    </>
  );
};


export default ShareRepoForm;
