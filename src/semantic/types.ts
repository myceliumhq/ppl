// The agent-facing contract paperless_search_documents merges into its
// lexical results (see src/tools/documents.ts). @myceliumhq/index's own
// SemanticMatch uses a string sourceId (source-agnostic); this plugin's
// document ids are numbers, so handle.ts adapts between the two at the
// boundary rather than pushing string ids through documents.ts's
// number-keyed maps.
export type SemanticMatch = {
  documentId: number;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
};
