# Legacy schema history

What the database was built from before `packages/db/migrations/0000_baseline.sql`.

Nothing here runs. It is kept because a baseline is only checkable against the
thing it replaced, and "read it in the git history" is a worse answer than a
directory when somebody is trying to work out why a column is the shape it is.

## `sql/`

The legacy backend's DDL, verbatim. `schema.sql` does not apply cleanly on its
own — it references `dataset_versions(id)` without creating it, and fourteen of
its statements are expected to fail. Its own header said so. `migrations/`
holds the 51 numbered files that followed, of which only 049 and 050 were ever
applied to the deployed database.

## `superseded-migrations/`

`packages/db/migrations/0000`–`0018` as they stood, plus the three test files
that covered them.

Those tests are the reason this directory has more than the SQL. Two of the
migrations carried a one-time DATA migration as well as a schema change — most
of all `0004_cim`, which read every `workspace_page_state` CIM blob into the
new deck tables, keyed on a field id it had to carry across verbatim. A
freshly-built database has no blob to import, so none of that belongs in the
baseline; but the assertions about how the import behaved are the only written
record of what it did to the databases it ran on.
