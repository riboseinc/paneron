import type { DiffStatus } from '@riboseinc/paneron-extension-kit/types/changes';
import { objectsHaveSameShape } from '@riboseinc/paneron-extension-kit/util';
import type { Hooks } from '@riboseinc/paneron-extension-kit/types/renderer';
import { API as Datasets } from './types';
import { diffDatasets } from '../repositories/util';


/**
 * Yields paths to buffers that differ between dataset1 and dataset2,
 * and ChangeStatus for each path.
 *
 * Behavior mimics `listDescendantPathsAtVersion()`
 * with `diffOpts.onlyChanged` set to true,
 * i.e. unchanged paths will not be returned.
 *
 * Intended to check for conflicts before committing changes.
 */
export async function* diffObjectDatasets(
  objectPaths: AsyncGenerator<string>,
  readObjects:
    (objectPath: string) =>
      Promise<[
        object1: Record<string, any> | null,
        object2: Record<string, any> | null,
      ]>,
): AsyncGenerator<[ path: string, changeStatus: DiffStatus ]> {
  return diffDatasets<Record<string, any>>(
    objectPaths,
    readObjects,
    objectsHaveSameShape,
  );
}


export function parsePredicateFunction(func: string): Datasets.Util.PredicateFunction {
  return new Function('key', 'value', func) as Datasets.Util.PredicateFunction;
}

export function parseMapReduceChain(
  chainID: string,
  chain: Hooks.Data.MapReduceChain,
): Datasets.Util.MapReduceChain<unknown> {
  let map: Datasets.Util.MapFunction;
  let reduce: Datasets.Util.ReduceFunction | undefined;
  let predicate: Datasets.Util.PredicateFunction | undefined;
  try {
    map = new Function('key', 'value', 'emit', chain.mapFunc) as Datasets.Util.MapFunction;
  } catch (e) {
    //log.error("Unable to parse submitted map function in map-reduce chain", chainID, chain.mapFunc, e);
    throw new Error("Unable to parse submitted map function");
  }
  if (chain.reduceFunc) {
    try {
      reduce = new Function('accumulator', 'value', chain.reduceFunc) as Datasets.Util.ReduceFunction;
    } catch (e) {
      //log.error("Unable to parse submitted reducer function in map-reduce chain", chainID, chain.reduceFunc, e);
      throw new Error("Unable to parse submitted reducer function");
    }
  }
  if (chain.predicateFunc) {
    try {
      predicate = parsePredicateFunction(chain.predicateFunc);
    } catch (e) {
      //log.error("Unable to parse submitted predicate function in map-reduce chain", chainID, chain.predicateFunc, e);
      throw new Error("Unable to parse submitted predicate function");
    }
  }
  return {
    id: chainID,
    map,
    reduce,
    predicate,
  };
}

export const isObjectDatasets = (datasets: unknown): datasets is { [path: string]: true } => {
  return typeof datasets === 'object' && !Array.isArray(datasets);
};

/**
 * Act as a facade for the different formats for
 * 'datasets'
 *
 * Given a 'datasets', which can be a string[] or
 * the original { [path: string]: true },
 * and two functions that accepts each one,
 * call the function that corresponds to the type of
 * 'datasets' and return its result.
 */
export const repoMetaDatasetsValueShim = <T>(
  unknownDatasets: unknown,
  arrayFn: (ary: string[]) => T,
  objectFn: (obj: { [path: string]: true }) => T,
  defaultValue: T,
  ) => {

  if (Array.isArray(unknownDatasets)) {
    return arrayFn(unknownDatasets);
  }

  if (isObjectDatasets(unknownDatasets)) {
    return objectFn(unknownDatasets);
  }

  return defaultValue as T;
};

/**
 * Act as a facade for the different formats for
 * 'datasets'
 *
 * Given a 'datasets', which can be a string[] or
 * the original { [path: string]: true },
 * and two functions that accepts each one,
 * call the function that corresponds to the type of
 * 'datasets'.
 */
export const repoMetaDatasetsShim = <T>(
  unknownDatasets: unknown,
  arrayFn: (ary: string[]) => T,
  objectFn: (obj: { [path: string]: true }) => T,
  ) => {

  return repoMetaDatasetsValueShim(
    unknownDatasets,
    arrayFn,
    objectFn,
    void 0,
  );
};

/**
 * Given 'datasets' and 'datasetId', return true iff
 * 'datasetId' is in 'datasets'.
 */
export const repoMetaDatasetsFound = (
  unknownDatasets: unknown,
  datasetId: string,
  ): boolean => {

  return repoMetaDatasetsValueShim(
    unknownDatasets,
    (ary) => ary.includes(datasetId),
    (obj) => obj[datasetId],
    false,
  );
};

/**
 * Given 'datasets', return the list of datasetIds within.
 */
export const repoMetaDatasets = (
  unknownDatasets: unknown,
  ): string[] => {

  return repoMetaDatasetsValueShim(
    unknownDatasets,
    (ary) => ary,
    (obj) => Object.keys(obj),
    [],
  );
};


// /**
//  * Returns `true` if both given objects have identical shape,
//  * disregarding key ordering.
//  *
//  * Only does a shallow check.
//  */
// function objectsAreSame(
//   obj1: Record<string, any>,
//   obj2: Record<string, any>,
// ): boolean {
//   return JSON.stringify(normalizeObject(obj1)) === JSON.stringify(normalizeObject(obj2));
// }
