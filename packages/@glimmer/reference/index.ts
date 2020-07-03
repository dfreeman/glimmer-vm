export {
  Reference as BasicReference,
  PathReference as BasicPathReference,
  VersionedReference as Reference,
  VersionedPathReference as PathReference,
  VersionedReference,
  VersionedPathReference,
  CachedReference,
  ReferenceCache,
  Validation,
  NotModified,
  isModified,
} from './lib/reference';

export { ConstReference } from './lib/const';

export * from './lib/template';

export * from './lib/iterable-impl';
