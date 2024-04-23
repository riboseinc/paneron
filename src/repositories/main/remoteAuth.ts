/** Storing & retrieving credentials for Git server authentication. */

import log from 'electron-log';

import { loadState, storeState, resetState, encryptionIsAvailable } from 'state/manage';


/**
 * Retrieves password saved for given remote.
 * If there is no password saved for given remote, and given remote
 * is a valid URL, also tries retrieving a password saved for
 * the hostname of that remote.
 *
 * Returns { username, password }; password may be undefined
 * if no stored password was found.
 *
 * Throws only if decryption facilities are not available.
 */
export async function getAuth(
  remote: string,
  username: string,
): Promise<{ password: string | undefined; username: string; }> {
  if (!encryptionIsAvailable()) {
    throw new Error("safeStorage API is not available on this systen");
  }

  let password = (await loadState(
    getStateKey(remote, username),
    { encrypted: true },
  ))?.password;

  if (!password) {
    const hostname = getHostname(remote);
    if (hostname) {
      password = (await loadState(
        getStateKey(hostname, username),
        { encrypted: true },
      ))?.password ?? undefined;
    }
  }

  return { password, username };
}


/**
 * Stores encrypted password for given remote.
 *
 * If remote is a valid URL, stores also a password for the hostname of the remote.
 * This way `getAuth()` may retrieve usable results
 * if the user doesn’t specify a password for this specific remote,
 * but uses the same password for the domain.
 *
 * If empty string is given as password, auth is reset for remote
 * (but not for hostname).
 *
 * May throw if decryption facilities are not available.
 */
export async function saveAuth(remote: string, username: string, password: string) {
  if (!encryptionIsAvailable()) {
    throw new Error("safeStorage API is not available on this systen");
  }

  const remoteKey = getStateKey(remote, username);

  if (password !== '') {
    const hostname = getHostname(remote);

    if (hostname) {
      await storeState(
        getStateKey(hostname, username),
        { password },
        { encrypted: true },
      );
    }
    await storeState(
      getStateKey(remote, username),
      { password },
      { encrypted: true },
    );

  } else {
    await resetState(remoteKey);
  }
}


function getStateKey(remote: string, username: string): string {
  return `remote-credentials-${remote}@${username}`;
}


function getHostname(remote: string): string | undefined {

  let url: URL | null;
  try {
    url = new URL(remote);
  } catch (e) {
    log.warn("Repositories: getAuth: Likely malformed Git remote URL", remote);
    url = null;
  }
  return url?.hostname;
}
