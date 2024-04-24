import { AbstractIterator } from 'abstract-leveldown';
import { LevelUp } from 'levelup';
import EncodingDown from 'encoding-down';
import { BufferChangeset } from '@riboseinc/paneron-extension-kit/types/buffers';
import { CommitOutcome, PathChanges } from '@riboseinc/paneron-extension-kit/types/changes';
import { IndexStatus } from '@riboseinc/paneron-extension-kit/types/indexes';
import { ObjectDataset } from '@riboseinc/paneron-extension-kit/types/objects';
import { AuthoringGitOperationParams, CommitRequestMessage, DatasetOperationParams, TreeUpdateCommitRequestMessage } from 'repositories/types';


export type ReturnsPromise<F extends (...opts: any[]) => any> =
  (...opts: Parameters<F>) => Promise<ReturnType<F>>


export type RecentlyOpenedDataset = {
  workDir: string
  datasetID: string
}


export interface DatasetType {
  id: string
  version: string
}


export interface DatasetInfo {
  title: string
  type: DatasetType
}


export interface MigrationError {
  currentMigrationVersionSpec?: string
  message: string
  conflicts?: PathChanges
}


export interface MigrationSequenceOutcome {
  success: boolean
  error?: MigrationError
  changesApplied: { commitHash: string, bufferChangeset: BufferChangeset }[]
}



export namespace API {


  export namespace Lifecycle {
    /**
     * Registers object specs and starts creating the default index
     * that contains all objects in the dataset.
     */
    export type Load = (msg: DatasetOperationParams & {
      cacheRoot: string
    }) => Promise<void>

    /** Stops all indexing, deregisters object specs. */
    export type Unload =
      (msg: DatasetOperationParams) => Promise<void>

    export type UnloadAll =
      (msg: { workDir?: string }) => Promise<void>
  }


  export namespace Indexes {

    /**
     * Creates a custom index that filters items in default index
     * using given query expression that evaluates in context of each object.
     *
     * Custom indexes contain object paths only, object data
     * is retrieved from default index.
     *
     * Returns index ID that can be used to query items. */
    export type GetOrCreateFiltered = (msg: DatasetOperationParams & {
      queryExpression: string
      keyExpression?: string
    }) => { indexID: string }

    /** If indexID is omitted, default index is described. */
    export type Describe = (msg: DatasetOperationParams & {
      indexID?: string
    }) => { status: IndexStatus }

    /* If indexID is omitted, default index is described. */
    // export type StreamStatus = (msg: DatasetOperationParams & {
    //   indexID?: string
    // }) => Observable<IndexStatus>

    /* If indexID is omitted, objects in default index are counted. */
    // Unnecessary. Use describe.
    // export type CountObjects = (msg: DatasetOperationParams & {
    //   indexID?: string
    // }) => Promise<{ objectCount: number }>

    /** Retrieves dataset-relative path of an object
        in the index at specified position. */
    export type GetFilteredObject = (msg: DatasetOperationParams & {
      indexID: string
      position: number
    }) => Promise<{ objectPath: string }>

    export type LocatePositionInFilteredIndex = (msg: DatasetOperationParams & {
      indexID: string
      objectPath: string
    }) => Promise<{ position: number }>
  }


  export namespace Data {

    /** Counts all objects in the dataset using default index. */
    export type CountObjects =
      (msg: DatasetOperationParams) => Promise<{ objectCount: number }>

    /** Returns a deserialized object dataset given dataset-relative object paths. */
    export type GetObjectDataset = (msg: DatasetOperationParams & {
      objectPaths: string[]

      /**
       * Attempt to resolve LFS pointers.
       * Does not guarantee all pointers will be resolved.
       */
      resolveLFS?: true
    }) => Promise<ObjectDataset>

    /**
     * Converts given objects to buffers using previously registered object specs,
     * checks for conflicts,
     * makes changes to buffers in working area,
     * stages and commits.
     * Returns commit hash and/or conflicts, if any.
     */
    export type UpdateObjects =
      (msg: CommitRequestMessage) => Promise<CommitOutcome>

    /**
     * This proxies a call to repository manager,
     * requesting to delete or move an entire subtree.
     *
     * This skips the logical object layer of abstraction,
     * does not do any consistency checks and can ruin data integrity if not used carefully.
     */
    export type UpdateTree =
      (msg: TreeUpdateCommitRequestMessage) => Promise<CommitOutcome>

    /**
     * This proxies a call to repository manager,
     * requesting to add new buffers from specified filesystem paths.
     *
     * This skips the logical object layer of abstraction,
     * does not do any consistency checks and can ruin data integrity if not used carefully.
     */
    export type UpdateObjectsExternal =
      (msg: AuthoringGitOperationParams & DatasetOperationParams & {
        /** Absolute filesystem paths to objects to add. */
        absoluteFilepaths: string[]
        /** Repo-relative POSIX-style path. */
        targetPath: string
        /** Replace `targetPath`, rather than add files beneath. */
        replaceTarget?: true
        offloadToLFS?: true
        commitMessage: string
      }) => Promise<CommitOutcome>
  }

  export namespace Util {

    export interface LoadedDataset {
      /** Absolute path to directory that will contain index caches. */
      indexDBRoot: string

      indexes: {
        // Includes “default” index and any custom/filtered indexes.
        // Default index ID is 'default'.
        // Filtered index ID is the hash of filter predicate function (query expression) string.
        [id: string]: ActiveDatasetIndex<any>
      }
    }

    export interface ActiveDatasetIndex<V> {
      dbHandle: LevelUp<EncodingDown<string, V>, AbstractIterator<string, V>>
      status: IndexStatus
      completionPromise?: Promise<true>

      //statusSubject: Subject<IndexStatus>

      //commitHash: string

      accessed?: Date

      // These are specific to default or filtered indexes

      // Filtered index only:
      sortedDBHandle?: LevelUp<EncodingDown<number, string>, AbstractIterator<number, string>>
      predicate?: FilteredIndexPredicate
      keyer?: FilteredIndexKeyer
    }


    export interface IndexMeta {
      completed: Date

      /**
       * Commit hash signifies which version of the repository the index in question was built against.
       * If, upon any index access, its hash doesn’t match the current HEAD commit hash as reported by Git,
       * indexes are expected to be updated.
       *
       * This also happens each time a new commit was added to the repository.
       *
       * Upon index update, frontend is notified.
       */
      commitHash: string

      objectCount: number
    }

    /**
     * A map of object path to deserialized object data or boolean false.
     * False values are stored at pre-indexing stage and indicate
     * that the objects exist but had not yet been indexed.
     */
    export type DefaultIndex = ActiveDatasetIndex<Record<string, any> | false> & {
    };

    /** This index’s dbHandle keeps custom keys associated with object paths
        (which are keys in default index) */
    export type FilteredIndex = ActiveDatasetIndex<string> & {

      /** A map of object’s numerical position according to the order of keys in this filtered index, and its path.
          Requested can use that path to query default index for object data. */
      sortedDBHandle: LevelUp<EncodingDown<number, string>, AbstractIterator<number, string>>
      accessed: Date
      predicate: FilteredIndexPredicate
      keyer?: FilteredIndexKeyer
    };

    export type FilteredIndexPredicate = (objPath: string, obj: Record<string, any>) => boolean;

    export type FilteredIndexKeyer = (item: Record<string, any>) => string | null;

    export type PredicateFunction = (key: string, value: unknown) => boolean;

    export type MapFunction = (key: string, value: unknown, emit: (val: unknown) => void) => void;

    export type ReduceFunction<T = any> = (accumulator: unknown, value: unknown) => T;

    export interface MapReduceChain<T> {
      id: string
      map: MapFunction
      reduce?: ReduceFunction<T>
      predicate?: PredicateFunction
    };

  }
}
