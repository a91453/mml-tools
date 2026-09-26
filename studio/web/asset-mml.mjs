// The MML string an MML-format asset stands for. A pasted or picked MML@
// string is its own content; a 3MLE .mml/.mmi file keeps the file text as its
// content (so a backup or a meter change re-reads the file) and the MML@ string
// read out of it as `mml` (backend/mml/community-formats.mjs).
export const assetMml = asset => (asset?.format === 'MML' ? (typeof asset.mml === 'string' ? asset.mml : typeof asset.content === 'string' ? asset.content : null) : null);
