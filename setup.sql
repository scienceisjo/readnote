-- ============================================================
-- 읽기 노트 설치 SQL
-- Supabase A 프로젝트(vbvtnmnodeoocbbjauap) → SQL Editor 에 통째로 붙여 넣고 Run 한 번.
-- 다시 돌려도 됩니다(기존 기록은 지워지지 않아요).
--
-- 구조
--   rn_rooms   : 읽기 방(책 한 권 또는 글 한 편). 참여코드·부분 목록·선생님 비밀번호(암호화)
--   rn_readers : 방에 들어온 학생(학번+이름, 기기 열쇠 token)
--   rn_entries : 학생 기록 한 칸(읽기 전 / 부분마다 / 읽은 뒤)
-- 표는 직접 읽고 쓸 수 없고(anon 권한 없음), 아래 함수로만 드나듭니다.
-- 선생님 비밀번호를 10번 틀리면 그 방은 10분 동안 잠깁니다.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.rn_rooms (
  id           bigint generated always as identity primary key,
  code         text not null unique,
  title        text not null,
  author       text not null default '',
  subject      text not null default '',
  chapters     jsonb not null default '[]'::jsonb,
  concept      text not null default '',
  guide        text not null default '',
  teacher_hash text not null,
  closed       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.rn_rooms add column if not exists opts         jsonb not null default '{}'::jsonb;
alter table public.rn_rooms add column if not exists fail_count   int not null default 0;
alter table public.rn_rooms add column if not exists locked_until timestamptz;

create table if not exists public.rn_readers (
  id          bigint generated always as identity primary key,
  room_id     bigint not null references public.rn_rooms(id) on delete cascade,
  student_no  text not null,
  name        text not null,
  token       uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (room_id, student_no)
);
create unique index if not exists rn_readers_token_idx on public.rn_readers(token);
create index if not exists rn_readers_room_idx on public.rn_readers(room_id);

create table if not exists public.rn_entries (
  id          bigint generated always as identity primary key,
  reader_id   bigint not null references public.rn_readers(id) on delete cascade,
  room_id     bigint not null references public.rn_rooms(id) on delete cascade,
  slot        text not null,
  data        jsonb not null default '{}'::jsonb,
  done        boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (reader_id, slot)
);
create index if not exists rn_entries_room_idx on public.rn_entries(room_id);

alter table public.rn_rooms   enable row level security;
alter table public.rn_readers enable row level security;
alter table public.rn_entries enable row level security;
revoke all on public.rn_rooms, public.rn_readers, public.rn_entries from anon, authenticated;

-- 앞판에서 쓰던 함수(돌려주는 모양이 바뀐 것)는 지우고 새로 만든다
drop function if exists public.rn_check_chapters(jsonb);
drop function if exists public.rn_teacher_room(text, text);
drop function if exists public.rn_create_room(text, text, text, jsonb, text, text, text);
drop function if exists public.rn_update_room(text, text, text, text, text, jsonb, text, text, boolean);
drop function if exists public.rn_teacher_fix_reader(text, text, bigint, text, text);
drop function if exists public.rn_teacher_remove_reader(text, text, bigint);

-- ------------------------------------------------------------
-- 내부 도우미 (밖에서 부를 수 없음)
-- ------------------------------------------------------------
create or replace function public.rn_room_json(r public.rn_rooms)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'code', r.code, 'title', r.title, 'author', r.author, 'subject', r.subject,
    'chapters', r.chapters, 'concept', r.concept, 'guide', r.guide, 'closed', r.closed,
    'opts', r.opts)
$$;

-- 부분 목록을 검사하고 id·name 만 남겨 돌려준다
create or replace function public.rn_clean_chapters(p jsonb)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array'
     or jsonb_array_length(p) = 0 or jsonb_array_length(p) > 60 then
    raise exception 'bad_chapters';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e->'id') is distinct from 'string'
       or jsonb_typeof(e->'name') is distinct from 'string'
       or (e->>'id') !~ '^[A-Za-z0-9_-]{1,16}$'
       or btrim(e->>'name') = ''
       or length(e->>'name') > 80
  ) then
    raise exception 'bad_chapters';
  end if;
  if (select count(distinct e->>'id') from jsonb_array_elements(p) e) <> jsonb_array_length(p) then
    raise exception 'bad_chapters';
  end if;
  select jsonb_agg(jsonb_build_object('id', e->>'id', 'name', btrim(e->>'name')) order by o)
    into v from jsonb_array_elements(p) with ordinality as t(e, o);
  return v;
end $$;

-- 방 설정: 지금은 AI 칸 보이기 하나
create or replace function public.rn_clean_opts(p jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'ai', case when jsonb_typeof(p->'ai') = 'boolean' then (p->'ai')::boolean else true end)
$$;

-- 선생님 확인. 오류를 raise 하지 않고 돌려준다(틀린 횟수 기록이 되돌려지지 않게)
create or replace function public.rn_teacher_auth(p_code text, p_pass text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare r public.rn_rooms;
begin
  select * into r from public.rn_rooms where code = upper(btrim(coalesce(p_code,''))) for update;
  if not found then return jsonb_build_object('error', 'no_room'); end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('error', 'locked');
  end if;
  if r.teacher_hash <> crypt(coalesce(p_pass,''), r.teacher_hash) then
    update public.rn_rooms set
      fail_count   = case when fail_count + 1 >= 10 then 0 else fail_count + 1 end,
      locked_until = case when fail_count + 1 >= 10 then now() + interval '10 minutes' else locked_until end
    where id = r.id;
    return jsonb_build_object('error', 'wrong_pass');
  end if;
  if r.fail_count <> 0 then update public.rn_rooms set fail_count = 0 where id = r.id; end if;
  return jsonb_build_object('ok', true, 'id', r.id);
end $$;

-- ------------------------------------------------------------
-- 학생용
-- ------------------------------------------------------------
create or replace function public.rn_room_public(p_code text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare r public.rn_rooms;
begin
  select * into r from public.rn_rooms where code = upper(btrim(coalesce(p_code,'')));
  if not found then return null; end if;
  return public.rn_room_json(r);
end $$;

create or replace function public.rn_join(p_code text, p_no text, p_name text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  r  public.rn_rooms;
  rd public.rn_readers;
  v_no   text := regexp_replace(coalesce(p_no,''), '[\s-]', '', 'g');
  v_name text := btrim(coalesce(p_name,''));
begin
  if v_no = '' or length(v_no) > 12 then raise exception 'bad_no'; end if;
  if v_name = '' or length(v_name) > 20 then raise exception 'bad_name'; end if;
  select * into r from public.rn_rooms where code = upper(btrim(coalesce(p_code,'')));
  if not found then raise exception 'no_room'; end if;

  select * into rd from public.rn_readers where room_id = r.id and student_no = v_no;
  if found then
    if regexp_replace(lower(rd.name), '\s', '', 'g') <> regexp_replace(lower(v_name), '\s', '', 'g') then
      raise exception 'name_mismatch';
    end if;
    update public.rn_readers set last_seen = now() where id = rd.id;
  else
    if r.closed then raise exception 'closed'; end if;
    if (select count(*) from public.rn_readers where room_id = r.id) >= 400 then
      raise exception 'room_full';
    end if;
    insert into public.rn_readers(room_id, student_no, name)
    values (r.id, v_no, v_name)
    on conflict (room_id, student_no) do nothing
    returning * into rd;
    if rd.id is null then  -- 같은 순간 두 번 눌렀을 때
      select * into rd from public.rn_readers where room_id = r.id and student_no = v_no;
      if regexp_replace(lower(rd.name), '\s', '', 'g') <> regexp_replace(lower(v_name), '\s', '', 'g') then
        raise exception 'name_mismatch';
      end if;
    end if;
  end if;

  return jsonb_build_object('token', rd.token, 'student_no', rd.student_no,
                            'name', rd.name, 'room', public.rn_room_json(r));
end $$;

create or replace function public.rn_my(p_token uuid)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare rd public.rn_readers; r public.rn_rooms;
begin
  select * into rd from public.rn_readers where token = p_token;
  if not found then raise exception 'no_reader'; end if;
  select * into r from public.rn_rooms where id = rd.room_id;
  update public.rn_readers set last_seen = now() where id = rd.id;
  return jsonb_build_object(
    'student_no', rd.student_no, 'name', rd.name, 'room', public.rn_room_json(r),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('slot', e.slot, 'data', e.data,
                                          'done', e.done, 'updated_at', e.updated_at))
      from public.rn_entries e where e.reader_id = rd.id), '[]'::jsonb));
end $$;

create or replace function public.rn_save(p_token uuid, p_slot text, p_data jsonb, p_done boolean)
returns timestamptz language plpgsql security definer
set search_path = public, extensions as $$
declare rd public.rn_readers; r public.rn_rooms; v_at timestamptz := now();
begin
  if p_slot is null or p_slot !~ '^(before|after|ch:[A-Za-z0-9_-]{1,16})$' then
    raise exception 'bad_slot';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'bad_data'; end if;
  if p_data ? 'questions' and jsonb_typeof(p_data->'questions') <> 'array' then raise exception 'bad_data'; end if;
  if p_data ? 'quote' and jsonb_typeof(p_data->'quote') <> 'object' then raise exception 'bad_data'; end if;
  if p_data ? 'stuck' and jsonb_typeof(p_data->'stuck') <> 'object' then raise exception 'bad_data'; end if;
  if length(p_data::text) > 20000 then raise exception 'too_long'; end if;

  select * into rd from public.rn_readers where token = p_token;
  if not found then raise exception 'no_reader'; end if;
  select * into r from public.rn_rooms where id = rd.room_id;
  if r.closed then raise exception 'closed'; end if;
  if p_slot like 'ch:%' and not exists (
    select 1 from jsonb_array_elements(r.chapters) c where 'ch:' || (c->>'id') = p_slot) then
    raise exception 'bad_slot';
  end if;

  insert into public.rn_entries(reader_id, room_id, slot, data, done, updated_at)
  values (rd.id, rd.room_id, p_slot, p_data, coalesce(p_done, false), v_at)
  on conflict (reader_id, slot)
  do update set data = excluded.data, done = excluded.done, updated_at = excluded.updated_at;

  update public.rn_readers set last_seen = v_at where id = rd.id;
  return v_at;
end $$;

-- ------------------------------------------------------------
-- 선생님용 (비밀번호 오류는 {"error": ...} 로 돌려준다)
-- ------------------------------------------------------------
create or replace function public.rn_create_room(
  p_title text, p_author text, p_subject text, p_chapters jsonb,
  p_concept text, p_guide text, p_pass text, p_opts jsonb)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_code  text;
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_ch    jsonb;
  i int; tries int := 0;
begin
  if btrim(coalesce(p_title,'')) = '' then raise exception 'bad_title'; end if;
  if length(coalesce(p_pass,'')) < 6 then raise exception 'short_pass'; end if;
  v_ch := public.rn_clean_chapters(p_chapters);
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rn_rooms where code = v_code);
    tries := tries + 1;
    if tries > 30 then raise exception 'code_fail'; end if;
  end loop;
  insert into public.rn_rooms(code, title, author, subject, chapters, concept, guide, opts, teacher_hash)
  values (v_code,
          left(btrim(p_title), 80),
          left(btrim(coalesce(p_author,'')), 60),
          left(btrim(coalesce(p_subject,'')), 30),
          v_ch,
          left(btrim(coalesce(p_concept,'')), 60),
          left(btrim(coalesce(p_guide,'')), 400),
          public.rn_clean_opts(coalesce(p_opts, '{}'::jsonb)),
          crypt(p_pass, gen_salt('bf')));
  return v_code;
end $$;

create or replace function public.rn_teacher_load(p_code text, p_pass text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare r public.rn_rooms; a jsonb;
begin
  a := public.rn_teacher_auth(p_code, p_pass);
  if a ? 'error' then return a; end if;
  select * into r from public.rn_rooms where id = (a->>'id')::bigint;
  return jsonb_build_object(
    'room', public.rn_room_json(r),
    'readers', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'student_no', d.student_no, 'name', d.name,
                                          'last_seen', d.last_seen, 'created_at', d.created_at)
                       order by d.student_no)
      from public.rn_readers d where d.room_id = r.id), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('reader_id', e.reader_id, 'slot', e.slot, 'data', e.data,
                                          'done', e.done, 'updated_at', e.updated_at))
      from public.rn_entries e where e.room_id = r.id), '[]'::jsonb));
end $$;

create or replace function public.rn_update_room(
  p_code text, p_pass text, p_title text, p_author text, p_subject text,
  p_chapters jsonb, p_concept text, p_guide text, p_closed boolean, p_opts jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare r public.rn_rooms; a jsonb; v_ch jsonb;
begin
  a := public.rn_teacher_auth(p_code, p_pass);
  if a ? 'error' then return a; end if;
  if btrim(coalesce(p_title,'')) = '' then raise exception 'bad_title'; end if;
  v_ch := public.rn_clean_chapters(p_chapters);
  -- 학생 기록이 있는 부분은 목록에서 뺄 수 없다
  if exists (
    select 1 from public.rn_entries e
    where e.room_id = (a->>'id')::bigint and e.slot like 'ch:%'
      and not exists (select 1 from jsonb_array_elements(v_ch) c where 'ch:' || (c->>'id') = e.slot)
  ) then
    raise exception 'chapter_in_use';
  end if;
  update public.rn_rooms set
    title    = left(btrim(p_title), 80),
    author   = left(btrim(coalesce(p_author,'')), 60),
    subject  = left(btrim(coalesce(p_subject,'')), 30),
    chapters = v_ch,
    concept  = left(btrim(coalesce(p_concept,'')), 60),
    guide    = left(btrim(coalesce(p_guide,'')), 400),
    closed   = coalesce(p_closed, false),
    opts     = public.rn_clean_opts(coalesce(p_opts, '{}'::jsonb)),
    updated_at = now()
  where id = (a->>'id')::bigint
  returning * into r;
  return public.rn_room_json(r);
end $$;

create or replace function public.rn_teacher_fix_reader(
  p_code text, p_pass text, p_reader_id bigint, p_no text, p_name text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  a jsonb;
  v_no   text := regexp_replace(coalesce(p_no,''), '[\s-]', '', 'g');
  v_name text := btrim(coalesce(p_name,''));
begin
  a := public.rn_teacher_auth(p_code, p_pass);
  if a ? 'error' then return a; end if;
  if v_no = '' or length(v_no) > 12 then raise exception 'bad_no'; end if;
  if v_name = '' or length(v_name) > 20 then raise exception 'bad_name'; end if;
  if exists (select 1 from public.rn_readers
             where room_id = (a->>'id')::bigint and student_no = v_no and id <> p_reader_id) then
    raise exception 'dup_no';
  end if;
  update public.rn_readers set student_no = v_no, name = v_name
  where id = p_reader_id and room_id = (a->>'id')::bigint;
  return jsonb_build_object('ok', found);
end $$;

create or replace function public.rn_teacher_remove_reader(p_code text, p_pass text, p_reader_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare a jsonb;
begin
  a := public.rn_teacher_auth(p_code, p_pass);
  if a ? 'error' then return a; end if;
  delete from public.rn_readers where id = p_reader_id and room_id = (a->>'id')::bigint;
  return jsonb_build_object('ok', found);
end $$;

-- ------------------------------------------------------------
-- 권한: 도우미는 막고, 공개 함수만 anon 에게
-- ------------------------------------------------------------
revoke execute on function public.rn_room_json(public.rn_rooms) from public, anon, authenticated;
revoke execute on function public.rn_clean_chapters(jsonb)       from public, anon, authenticated;
revoke execute on function public.rn_clean_opts(jsonb)           from public, anon, authenticated;
revoke execute on function public.rn_teacher_auth(text, text)    from public, anon, authenticated;

revoke execute on function public.rn_room_public(text)                         from public;
revoke execute on function public.rn_join(text, text, text)                    from public;
revoke execute on function public.rn_my(uuid)                                  from public;
revoke execute on function public.rn_save(uuid, text, jsonb, boolean)          from public;
revoke execute on function public.rn_create_room(text, text, text, jsonb, text, text, text, jsonb) from public;
revoke execute on function public.rn_teacher_load(text, text)                  from public;
revoke execute on function public.rn_update_room(text, text, text, text, text, jsonb, text, text, boolean, jsonb) from public;
revoke execute on function public.rn_teacher_fix_reader(text, text, bigint, text, text) from public;
revoke execute on function public.rn_teacher_remove_reader(text, text, bigint) from public;

grant usage on schema public to anon, authenticated;
grant execute on function public.rn_room_public(text)                         to anon, authenticated;
grant execute on function public.rn_join(text, text, text)                    to anon, authenticated;
grant execute on function public.rn_my(uuid)                                  to anon, authenticated;
grant execute on function public.rn_save(uuid, text, jsonb, boolean)          to anon, authenticated;
grant execute on function public.rn_create_room(text, text, text, jsonb, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.rn_teacher_load(text, text)                  to anon, authenticated;
grant execute on function public.rn_update_room(text, text, text, text, text, jsonb, text, text, boolean, jsonb) to anon, authenticated;
grant execute on function public.rn_teacher_fix_reader(text, text, bigint, text, text) to anon, authenticated;
grant execute on function public.rn_teacher_remove_reader(text, text, bigint) to anon, authenticated;

notify pgrst, 'reload schema';

-- 확인: 아래 줄이 함수 9개를 보여 주면 설치 끝
select p.proname as 함수
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'rn\_%' escape '\'
  and has_function_privilege('anon', p.oid, 'execute')
order by 1;
