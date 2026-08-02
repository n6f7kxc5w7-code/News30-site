# Security

## Why this file exists

In July 2026 this project's Gemini API key was compiled into the public JavaScript bundle via a `VITE_GEMINI_API_KEY` environment variable. An automated scanner harvested it from the deployed site, used it, and Google suspended the entire Cloud project. The fix was architectural: every secret now lives server-side behind a function in `api/`, and nothing in `src/` handles a key.

The lesson generalises beyond that one variable. The pattern was *assuming something was protected when nothing was actually protecting it*. Row Level Security is the same class of problem, so it is documented here rather than left implicit.

---

## The anon key is public. RLS is the actual lock.

`VITE_SUPABASE_ANON_KEY` is compiled into the client bundle by design — Supabase intends for it to be public, and there is no way to use Supabase from a browser without shipping it. Anyone can open dev tools, copy that key, and make direct API calls to your project.

**With RLS disabled, that means anyone can read and write every row in every table.** Not through your UI, through `curl`.

RLS policies are therefore not a hardening step to do before launch. They are the only access control that exists.

### Note on `service_role`

`SUPABASE_SERVICE_ROLE_KEY` **bypasses RLS entirely**. That is intentional and is why the pipeline functions in `api/` keep working after these policies are applied. It is also why that key must never appear in client code, in a `VITE_` variable, or in this repo.

---

## Migration

Run the whole of this in Supabase → SQL editor. It is idempotent — safe to run more than once.

### 1. Tie user data to `auth.uid()` instead of email

`user_state` and `events` were originally keyed on `user_email`. Email is a poor security anchor because the client supplies it — a policy comparing a row's email to a client-supplied email protects nothing. `auth.uid()` comes from the verified JWT and cannot be forged.

```sql
-- Add the real identity column
alter table user_state add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table events     add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Backfill existing rows by matching on email
update user_state us
set user_id = au.id
from auth.users au
where us.user_id is null and lower(au.email) = lower(us.user_email);

update events e
set user_id = au.id
from auth.users au
where e.user_id is null and lower(au.email) = lower(e.user_email);

create unique index if not exists user_state_user_id_key on user_state(user_id);
create index if not exists events_user_id_idx on events(user_id);
```

Any rows that fail to backfill belong to emails with no corresponding auth user. Check what's left before deleting anything:

```sql
select count(*) from user_state where user_id is null;
```

### 2. Enable RLS

Enabling RLS with no policies denies everything by default, which is the correct starting point.

```sql
alter table user_state enable row level security;
alter table events     enable row level security;
alter table video_jobs enable row level security;
```

### 3. `user_state` — each user sees only their own row

```sql
drop policy if exists "read own state"   on user_state;
drop policy if exists "insert own state" on user_state;
drop policy if exists "update own state" on user_state;

create policy "read own state" on user_state
  for select using (auth.uid() = user_id);

create policy "insert own state" on user_state
  for insert with check (auth.uid() = user_id);

create policy "update own state" on user_state
  for update using (auth.uid() = user_id)
          with check (auth.uid() = user_id);
```

No delete policy — users cannot delete their own state row from the client. If that's wanted later, add one explicitly rather than leaving a gap.

Note the `with check` on update. Without it, a user could pass the `using` check on a row they own and then rewrite `user_id` to point at someone else.

### 4. `events` — append-only

```sql
drop policy if exists "read own events"   on events;
drop policy if exists "insert own events" on events;

create policy "read own events" on events
  for select using (auth.uid() = user_id);

create policy "insert own events" on events
  for insert with check (auth.uid() = user_id);
```

Deliberately no update or delete policy. Engagement events are an audit trail; clients should never be able to rewrite history.

### 5. `video_jobs` — public read of finished videos only

Signed-out visitors need to watch videos, so anonymous reads are allowed — but only for completed jobs.

```sql
drop policy if exists "public read finished videos" on video_jobs;

create policy "public read finished videos" on video_jobs
  for select using (status = 'done');
```

Restricting to `status = 'done'` matters: the `error` column contains raw failure strings, and in-progress rows expose scripts before publication. Neither should be world-readable.

There is **no insert, update or delete policy on `video_jobs` at all**. Only the pipeline functions write to this table, and they use `service_role`, which bypasses RLS. A visitor with the anon key cannot create or modify a job.

### 6. Storage

The `media` bucket is public so finished MP3s and MP4s can be served directly. Uploads happen only from `api/` using `service_role`, so no client-side insert policy should exist. Verify in Supabase → Storage → `media` → Policies that there is no anon INSERT/UPDATE/DELETE policy.

---

## Verifying it works

Enabling RLS incorrectly silently breaks the app instead of erroring loudly, so test both directions.

**1. Anonymous access is blocked.** In your browser dev tools on the deployed site, with no user signed in:

```js
const { data, error } = await supabase.from('user_state').select('*');
console.log(data, error);
```

`data` should be an empty array. If it returns rows, RLS is not on.

**2. Signed-in access still works.** Sign in, then reload. Quiz results and login streaks should persist as before. If they silently stop saving, a policy is too strict — check the browser console for Supabase errors rather than assuming the feature broke.

**3. The pipeline still works.** Run a render through `test-pipeline.html`. It uses `service_role` server-side, so it should be entirely unaffected. If it breaks, the wrong key is being used somewhere in `api/`.

**4. Public video reads still work.** Signed out, confirm finished videos still load.

---

## Still outstanding

- **`public/test-pipeline.html` is world-reachable** at `/test-pipeline.html`. It calls `/api/generate-audio` and `/api/generate-video`, both of which cost real money per invocation. CORS restricts *browser* calls from other origins, but not direct requests, and not someone simply visiting the page. Delete it or gate it before launch.
- **No rate limiting** on the pipeline endpoints. A loop or a bored visitor can run up a bill within the £50/month ceiling faster than expected. `PIPELINE_ENABLED=false` is the emergency stop, but it is manual.
- **Google OAuth client** is disabled while the Cloud project is suspended, which takes sign-in down with it. Worth adding magic-link or email/password auth via Supabase as a fallback so a single Google outage doesn't remove all authentication.
