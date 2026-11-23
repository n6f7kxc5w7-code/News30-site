// /api/_optional-columns.js
// Not an endpoint (leading underscore) — shared by the pipeline functions
// and scripts/upload.js.
//
// PostgREST rejects a whole update/select that names a column the table
// doesn't have. New columns are added by hand-run migrations, so without
// this a deploy that lands before the migration would stop stories from
// publishing at all. Instead: try with the new columns, and if the error
// is "no such column", retry without them and say which migration to run.
//
// Columns this currently covers (run once in Supabase → SQL editor):
//
//   alter table video_jobs
//     add column if not exists youtube_title text;
//   alter table published_stories
//     add column if not exists youtube_title text,
//     add column if not exists entities jsonb;

export function isMissingColumn(error, columns) {
  if (!error) return false;
  const msg = String(error.message || "") + " " + String(error.details || "");
  const code = String(error.code || "");
  const columnError = code === "PGRST204" || code === "42703" || /column/i.test(msg);
  return columnError && columns.some((c) => msg.includes(c));
}

/** update(values).eq("id", id); on a missing optional column, retries
    without the optional keys. Resolves to the final { error }. */
export async function updateWithOptional(supabase, table, id, values, optionalKeys) {
  let { error } = await supabase.from(table).update(values).eq("id", id);
  if (error && isMissingColumn(error, optionalKeys)) {
    console.warn(
      "[optional-columns] " + table + " is missing " + optionalKeys.join("/") +
      " — saved without them. Run the migration in api/_optional-columns.js."
    );
    const rest = { ...values };
    for (const k of optionalKeys) delete rest[k];
    ({ error } = await supabase.from(table).update(rest).eq("id", id));
  }
  return { error };
}
