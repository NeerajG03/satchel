begin;

-- The schedule could never be switched on.
--
-- 20260922170000 checked the endpoint with `[^\s]{1,300}`, and Postgres
-- refuses any regex repetition count over 255. The table was created fine,
-- because a check constraint's regex is compiled when a row is tested, not
-- when the constraint is made. So every insert failed, which means every call
-- to enable_consolidation failed with "invalid regular expression", and
-- consolidation_credentials has been empty in production since it shipped.
--
-- Same rule, said in a way Postgres can compile: a URL with no whitespace,
-- and a length check of its own.
alter table public.consolidation_credentials
  drop constraint consolidation_credentials_endpoint_check;
alter table public.consolidation_credentials
  add constraint consolidation_credentials_endpoint_check
  check (endpoint ~ '^https?://\S+$' and length(endpoint) <= 308);

commit;
