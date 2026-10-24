export function parseRoots(text) {
  const seen = new Set();
  const roots = text.split(/[\n,，;；]+/).map((word) => word.trim().replace(/\s+/g, " "))
    .filter((word) => {
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (roots.length > 200) throw new Error("一次最多 200 个词根，请分批处理。");
  if (roots.some((word) => word.length > 150)) throw new Error("单个词根不能超过 150 个字符。");
  return roots;
}

export function parseBatches(text) {
  const batches = text.split(/\r?\n/).map(parseRoots).filter((roots) => roots.length);
  if (batches.reduce((total, roots) => total + roots.length, 0) > 200) {
    throw new Error("词根总数最多 200 个，请减少行数或每行词根。");
  }
  return batches;
}

export function appendRootBatches(text, selected) {
  const batches = parseBatches(text);
  const firstBatch = batches.length;
  const existing = new Set(batches.flat().map((root) => root.toLowerCase()));
  const added = parseRoots(selected.join(",")).filter((root) => !existing.has(root.toLowerCase()));
  for (let index = 0; index < added.length; index += 5) batches.push(added.slice(index, index + 5));
  const roots = batches.map((batch) => batch.join(", ")).join("\n");
  parseBatches(roots); // Validate the total before changing the current list.
  return { roots, added: added.length, firstBatch };
}
