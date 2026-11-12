-- Daily count of Gemini embedding requests spent on listings, used to keep part of the free-tier
-- quota for users' profiles. Days are Pacific Time, matching Gemini's quota reset.
create table if not exists public.ai_usage (
  day date primary key,
  listing_embeddings integer not null default 0
);

-- No policies: only the server's service-role key reads and writes this table.
alter table public.ai_usage enable row level security;
