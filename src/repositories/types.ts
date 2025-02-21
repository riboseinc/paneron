import type { Progress } from '@riboseinc/paneron-extension-kit/types/progress';
import type { BufferChangeset } from '@riboseinc/paneron-extension-kit/types/buffers';
import type { ObjectChangeset } from '@riboseinc/paneron-extension-kit/types/objects';


/** Used to signify the special case of dataset occupying the root of the repo. */
export const SOLE_DATASET_ID = '@';


// Repository info

export type PaneronRepository = {
  title?: string
} & ({
  datasets: string[] | { [path: string]: true }
  dataset?: undefined
} | {
  datasets?: undefined
  dataset: true
})

/** Data used to work with a locally cloned Git repository. */
export interface GitRepository {
  /** Working directory location, absolute end-user platform-specific path. */
  workingCopyPath: string

  /** Custom label assigned by the user, e.g. if there are similar repositories. */
  label?: string

  /** This is the branch in use; not necessarily the main/master branch. */
  mainBranch: string

  /** Current local latest commit on `mainBranch`. */
  head?: string

  /** Remote, if connected. */
  remote?: GitRemote

  /** Author information required for making commits. */
  author?: GitAuthor
}

export interface CommitMeta {
  hash: string

  message: string

  author?: GitAuthor

  /** UTC Unix timestamp */
  authoredAt?: number

  committer?: GitAuthor

  /** UTC Unix timestamp */
  committedAt?: number

  /** Hashes of parent commits */
  parents: string[]

  signatureVerified?: true
}

export interface Repository {
  gitMeta: GitRepository
  paneronMeta?: PaneronRepository
}

export interface GitRemote {
  username: string
  url: string

  /** Whether remote was added with commit access. */
  writeAccess?: true

  /** Current remote latest commit on `mainBranch`. */
  head?: string
}

export interface RepositoryListQuery {
  sortBy?: 'recentlyLoaded'
  matchesText?: string
}


// Creating repos

export interface NewRepositoryDefaults {
  //workingDirectoryContainer?: string
  remote?: Omit<GitRemote, 'url'>
  branch?: string
  author: GitAuthor
}


// Repository status

/** Initializing a new repository locally */
interface CreationStatus {
  operation: 'creating'
}

/** During start up */
interface InitStatus {
  operation: 'initializing'
}

interface LocalChecksStatus {
  operation: 'checking-local-changes'
}

export interface AuthoringOpStatus {
  awaitingAuthorInfo?: boolean
}
interface CommitStatus extends AuthoringOpStatus {
  operation: 'committing'
}

export interface RemoteOpStatus {
  awaitingPassword?: boolean
  networkError?: true
  progress?: Progress
}
interface LFSUploadStatus extends RemoteOpStatus {
  operation: 'uploading to LFS'
}
interface PullStatus extends RemoteOpStatus {
  operation: 'pulling'
}
interface PushStatus extends RemoteOpStatus {
  operation: 'pushing'
}
interface CloneStatus extends RemoteOpStatus {
  operation: 'cloning'
}

type RepoOperationStatus =
    InitStatus
  | CreationStatus
  | CloneStatus
  | PullStatus
  | PushStatus
  | LocalChecksStatus
  | CommitStatus
  | LFSUploadStatus;

export type RepoStatus = {
  status: 'ahead' | 'behind' | 'diverged' | 'ready'
  localHead: string
  busy?: undefined
} | {
  status: 'unloaded' | 'invalid-working-copy'
  localHead?: undefined
  busy?: undefined
} | {
  busy: RepoOperationStatus
  status?: undefined
  localHead?: undefined
}

export type RepoStatusUpdater = (newStatus: RepoStatus) => void;


/** Result of comparing local and remote heads. */
export interface RemoteHeadComparisonOutcome {
  /** Remote branch head commit OID. */
  remoteHead: string

  /** Empty, unless remote head is divergent from local head. */
  commonAncestor?: string
}



// Git-related types used by worker

/** Authentication as expected by Isomorphic Git */
export interface GitAuthentication {
  username?: string
  password?: string

  // Unsupported currently
  oauth2format?: 'github' | 'gitlab' | 'bitbucket'
  token?: string
}

export interface GitAuthor {
  name: string
  email: string
}


export interface LFSParams {
  /**
   * Base repository URL.
   * Individual LFS endpoints will be expected under it per LFS spec.
   */
  url: string

  /** Basic auth credentials. */
  auth: { username: string, password: string }
}


// Worker operation parameters (“worker messages”).

export interface GitOperationParams {
  /**
   * Absolute path to Git working directory root,
   * specific to current platform if using Node on desktop.
   */
  workDir: string

  /** Optional for now, but most operations will be branch-based eventually. */
  branch?: string
}

export interface DatasetOperationParams extends GitOperationParams {
  datasetID: string
}

export interface AuthoringGitOperationParams extends GitOperationParams {
  author: GitAuthor
}

export interface RemoteGitOperationParams extends GitOperationParams {
  repoURL: string
  auth: GitAuthentication
  _presumeCanceledErrorMeansAwaitingAuth?: true
}


export interface StatusRequestMessage extends GitOperationParams {}
export interface InitRequestMessage extends GitOperationParams {
  defaultBranch: string
}

export interface CloneRequestMessage extends RemoteGitOperationParams {
  branch: string
}
export interface PullRequestMessage extends RemoteGitOperationParams, AuthoringGitOperationParams {}
export interface PushRequestMessage extends RemoteGitOperationParams {
  // Passing this parameter implies rejected push should not be treated as error.
  _presumeRejectedPushMeansNothingToPush?: true

  // TODO: Get rid of `_presumeRejectedPushMeansNothingToPush`.
  // (Either when Isomorphic Git stops rejecting push when nothing to push,
  // or when we start checking server refs before attempting push.)
}

export interface FetchRequestMessage extends RemoteGitOperationParams {}

export interface BufferDataRequestMessage extends GitOperationParams {
  /** A list of repo-relative POSIX paths. */
  bufferPaths: string[]
}

export interface ObjectDataRequestMessage extends GitOperationParams {
  /** A list of repo-relative POSIX paths. */
  objectPaths: string[]
}

export interface BufferCommitRequestMessage extends AuthoringGitOperationParams {
  /** Buffer changeset, with repository-relative paths. */
  bufferChangeset: BufferChangeset
  commitMessage: string

  /**
   * Whether it is supposed to be an initial commit.
   * Suppresses some logic around diffing changes.
   */
  initial?: true

  /**
   * Makes Paneron not strictly check that preexisting values
   * match `oldValue`s in given changeset.
   */
  _dangerouslySkipValidation?: true
}

export interface CommitRequestMessage extends AuthoringGitOperationParams, DatasetOperationParams {
  objectChangeset: ObjectChangeset
  commitMessage: string

  /**
   * Makes Paneron not strictly check that preexisting values
   * match `oldValue`s in given changeset. Allows `oldValue`s to be undefined.
   */
  _dangerouslySkipValidation?: true
}

export interface TreeUpdateCommitRequestMessage extends AuthoringGitOperationParams, DatasetOperationParams {
  /** Repo-relative POSIX path. */
  oldSubtreePath: string
  /** Repo-relative POSIX path. */
  newSubtreePath: string | null // NOTE: if null, deletes subtree
  commitMessage: string
}

export interface DeleteRequestMessage extends GitOperationParams {
  yesReallyDestroyLocalWorkingCopy: true
}

// export type ObjectRequester<Encoding extends string | undefined> =
//   (msg: ObjectDataRequestMessage<Encoding>) => Encoding extends string


export type WorkerMessage =
  CloneRequestMessage
  | PullRequestMessage
  | FetchRequestMessage
  | PushRequestMessage;
