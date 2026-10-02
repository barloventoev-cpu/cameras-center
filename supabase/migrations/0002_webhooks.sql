-- ===========================================================================
-- Cameras Center — webhooks persistentes + nada nuevo para retención
-- (la purga usa la tabla `events` existente y borra assets en Cloudinary)
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Webhooks (F6): sobreviven reinicios (antes sólo vivían en memoria).
--   secret: secreto HMAC cifrado con CAMERA_ENC_KEY (igual que las URLs de
--   cámara); jamás se expone en la API después de crearlo.
-- ---------------------------------------------------------------------------
create table if not exists public.webhooks (
  id         uuid primary key default gen_random_uuid(),
  url        text not null,
  secret     text not null,
  events     text[] not null default '{motion}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists webhooks_active_idx on public.webhooks (active, created_at desc);

alter table public.webhooks enable row level security;

-- Sin políticas: sólo el service_role (bypass) tiene acceso desde el server.
