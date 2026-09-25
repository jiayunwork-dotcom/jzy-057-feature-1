export { CrdtDoc, mergeOps } from './crdt/CrdtDoc.js';
export type { Snapshot } from './crdt/CrdtDoc.js';
export {
  compareId,
  idKey,
  opKey,
  type Id,
  type InsertOp,
  type DeleteOp,
  type Op,
} from './crdt/types.js';

export {
  resolveAnchor,
  resolveAnchors,
  similarity,
  type Anchor,
  type AnchorStatus,
  type ResolvedAnchor,
} from './anchor/anchor.js';

export {
  myers,
  diffText,
  tokenizeLine,
  type DiffPart,
  type DiffType,
  type LineDiffRow,
  type RowType,
} from './diff/diff.js';

export {
  materialize,
  materializeHead,
  diffVersions,
  rollbackOps,
  createVersion,
  type VersionHistory,
  type VersionMeta,
  type VersionKind,
  type MaterializedVersion,
} from './version/version.js';

export {
  REF_MARKER_PREFIX,
  REF_MARKER_SUFFIX,
  REF_MARKER_RE,
  refMarker,
  parseRefMarkers,
  referencedExcerptIds,
  type RefMarker,
  resolveExcerpt,
  type ExcerptAnchor,
  type ResolvedExcerpt,
  type ExcerptStatus,
  ReferenceGraph,
  expandMarkdown,
  MAX_EXPAND_DEPTH,
  type RefResolver,
  type ResolvedRef,
  type RenderBlock,
} from './ref/index.js';
