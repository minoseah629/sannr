// Shared by the rename gate and its adversarial specimens. Fixtures stay in
// temporary projects; these helpers never enumerate a caller's checkout.
export function productMentionPattern(product) {
  return new RegExp(product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export function unlistedProseSurfaces(files, listed, read, product) {
  return files.filter(file => productMentionPattern(product).test(read(file)) && !listed.includes(file));
}
