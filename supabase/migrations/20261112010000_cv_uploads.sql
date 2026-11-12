-- CV uploads: a private bucket where each user keeps one CV in a folder named after their user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cvs', 'cvs', false, 5242880, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
])
on conflict (id) do nothing;

drop policy if exists cvs_select_own on storage.objects;
create policy cvs_select_own on storage.objects for select to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists cvs_insert_own on storage.objects;
create policy cvs_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists cvs_update_own on storage.objects;
create policy cvs_update_own on storage.objects for update to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists cvs_delete_own on storage.objects;
create policy cvs_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- The uploaded file's original name, shown back to the user; its text is kept in cv_text for matching.
alter table public.profiles add column if not exists cv_file_name text not null default '';
