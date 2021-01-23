import { ObjectDataset } from '@riboseinc/paneron-extension-kit/types/objects';
import { readBuffers } from '../buffers/read';
import { Datasets } from '../types';
import { getIndex, normalizeDatasetDir } from '../datasets';
import { SerializableObjectSpec } from '@riboseinc/paneron-extension-kit/types/object-spec';


/* Do not read too many objects at once. May be slow. */
export const readObjects: Datasets.Data.ReadObjects = async function ({
  workDir,
  datasetDir,
  objectPaths,
}) {
  const datasetDirNormalized = normalizeDatasetDir(datasetDir);

  const objectDataset: ObjectDataset = (await Promise.all(
    objectPaths.map(async (objectPath) => {
      return {
        [objectPath]: await readObject(
          objectPath,
          workDir,
          datasetDirNormalized),
      };
    })
  )).reduce((prev, curr) => ({ ...prev, ...curr }), {});

  return objectDataset;
}


/* Reads structured object data.
   Object must be loaded into default dataset index first.
*/
export async function readObject(
  objectPath: string,
  workDir: string,
  datasetDir: string,
): Promise<Record<string, any> | null> {
  const idx: Datasets.Util.DefaultIndex = getIndex(workDir, datasetDir);

  let result: Record<string, any> | undefined;
  try {
    result = await idx.dbHandle.get(objectPath);
  } catch (e) {
    if (e.type === 'NotFoundError') {
      return null;
    } else {
      throw e;
    }
  }

  if (result === undefined) {
    throw new Error("Object had not yet been indexed")
  }

  return result;
}


/* Given a generator of object paths, yields objects.
   Each object is created using the provided makeObject. */
export async function* readObjectsCold(
  objectPaths: AsyncGenerator<string>,
  makeObject: (fromBuffers: Record<string, Uint8Array>) => Record<string, any>,
): AsyncGenerator<Record<string, any>> {
  for await (const objectPath of objectPaths) {
    const buffers = await readBuffers(objectPath);
    yield makeObject(buffers);
  }
}


export async function readObjectCold(
  rootPath: string,
  spec: SerializableObjectSpec,
): Promise<Record<string, any> | null> {
  const bufferDataset = await readBuffers(rootPath);
  const obj: Record<string, any> = spec.deserialize(bufferDataset);
  return obj;
}
