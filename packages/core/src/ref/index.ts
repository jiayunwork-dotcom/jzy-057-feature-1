export {
  REF_MARKER_PREFIX,
  REF_MARKER_SUFFIX,
  REF_MARKER_RE,
  refMarker,
  parseRefMarkers,
  referencedExcerptIds,
  type RefMarker,
} from './marker.js';

export {
  resolveExcerpt,
  type ExcerptAnchor,
  type ResolvedExcerpt,
  type ExcerptStatus,
} from './excerpt.js';

export { ReferenceGraph } from './graph.js';

export {
  expandMarkdown,
  MAX_EXPAND_DEPTH,
  type RefResolver,
  type ResolvedRef,
  type RenderBlock,
} from './expand.js';
