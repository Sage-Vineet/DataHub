/**
 * An optional field a caller is clearing.
 *
 * The contracts type these as optional strings rather than nullable ones, so
 * `undefined` means "leave it alone" and there is no way to say "remove it"
 * except by sending an empty one. Stored as `""` that leaves the column
 * holding an empty string for some rows and NULL for others, and every reader
 * downstream has to handle both — which is exactly the sort of thing that
 * works until one reader forgets.
 *
 * An empty string is therefore stored as absent, which also makes a field
 * clearable at all: before this it could be set and never unset.
 */
export function cleared<T extends string>(value: T | null | undefined): T | null {
  return value === undefined || value === null || value.trim() === "" ? null : value;
}
