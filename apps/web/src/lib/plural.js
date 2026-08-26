/**
 * Count plus noun, agreeing in number.
 *
 * Written out because the product kept rendering "1 requests", "1 items" and
 * "1 request(s)" — three different ways of not doing this. `(s)` is a
 * particular kind of giving up: it is visible to every reader on every row,
 * including the ones where it is wrong.
 */
export function plural(count, singular, pluralForm) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : pluralForm ?? `${singular}s`}`;
}
