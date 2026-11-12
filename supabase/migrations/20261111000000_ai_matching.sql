-- AI matching: Gemini embeddings (768 dimensions) for profiles and listings, ranked with pgvector.
-- Additive only: it extends the existing profiles and opportunities tables and drops nothing.

create extension if not exists vector with schema extensions;

-- One embedding per listing, written by the sync route.
alter table public.opportunities add column if not exists embedding extensions.vector(768);

create index if not exists opportunities_embedding_idx
  on public.opportunities using hnsw (embedding extensions.vector_cosine_ops);

-- Profile fields the matching engine reads, beside the existing full_name, location, role_title,
-- years_experience, bio and skills columns.
alter table public.profiles
  add column if not exists looking_for text not null default '',
  add column if not exists experience text not null default '',
  add column if not exists education text not null default '',
  add column if not exists cv_text text not null default '',
  add column if not exists embedding extensions.vector(768);

-- Lets a user delete their own profile (Zambia Data Protection Act, 2021).
drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated using ((select auth.uid()) = id);

-- Ranks recent listings by cosine similarity to a profile embedding (FR-06). Every listing is scored
-- exactly: ordering by the computed similarity (not by the distance operator) keeps the planner off
-- the HNSW index, whose scans stop at hnsw.ef_search (40) rows.
create or replace function public.match_opportunities(
  query_embedding extensions.vector(768),
  min_posted_at timestamptz,
  match_count integer default 2000
)
returns table (opportunity_id text, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  select scored.id, scored.similarity
  from (
    select o.id::text as id, 1 - (o.embedding <=> query_embedding) as similarity
    from public.opportunities o
    where o.embedding is not null and o.posted_at >= min_posted_at
  ) scored
  order by scored.similarity desc
  limit match_count;
$$;

revoke execute on function public.match_opportunities(extensions.vector, timestamptz, integer) from public, anon;
grant execute on function public.match_opportunities(extensions.vector, timestamptz, integer) to authenticated;
