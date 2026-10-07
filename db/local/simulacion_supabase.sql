-- ============================================================================
--  SIMULACIÓN MÍNIMA DE SUPABASE PARA DESARROLLO LOCAL Y PRUEBAS
--
--  NO es una migración: nunca se aplica al proyecto real de Supabase (que ya
--  trae estos objetos). Recrea solo lo que el DDL de supabase/migrations/
--  necesita para cargar sin cambios en un PostgreSQL + PostGIS vacío:
--    * los roles anon, authenticated y service_role;
--    * auth.users (columnas que leen los disparadores) y auth.uid();
--    * realtime.messages, realtime.topic() y realtime.send().
--    * PostGIS y pgcrypto en el esquema extensions, y extensions en el
--      search_path de los roles, como en un proyecto real de Supabase.
-- ============================================================================

-- Supabase instala las extensiones en "extensions", no en "public". Sin esto,
-- el local no detecta consultas que dependen de dónde vive PostGIS.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
SET search_path = "$user", public, extensions;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
END $$;

-- Los roles de Supabase traen extensions en su search_path; app_backend no
-- (lo crea la migración y su search_path lo fija una migración posterior).
ALTER ROLE postgres SET search_path = "$user", public, extensions;
ALTER ROLE anon SET search_path = "$user", public, extensions;
ALTER ROLE authenticated SET search_path = "$user", public, extensions;
ALTER ROLE service_role SET search_path = "$user", public, extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- Supabase concede estos privilegios de fábrica; el DDL v3 los revoca.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
    instance_id            uuid,
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    aud                    varchar(255),
    role                   varchar(255),
    email                  varchar(255),
    encrypted_password     varchar(255),
    email_confirmed_at     timestamptz,
    confirmation_token     varchar(255),
    recovery_token         varchar(255),
    email_change           varchar(255),
    email_change_token_new varchar(255),
    raw_app_meta_data      jsonb,
    raw_user_meta_data     jsonb,
    banned_until           timestamptz,
    created_at             timestamptz DEFAULT now(),
    updated_at             timestamptz DEFAULT now()
);

-- Identidades por proveedor (GoTrue exige una fila 'email' para iniciar sesión con contraseña).
CREATE TABLE IF NOT EXISTS auth.identities (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    provider_id     text        NOT NULL,
    provider        text        NOT NULL,
    identity_data   jsonb       NOT NULL,
    last_sign_in_at timestamptz,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE (provider_id, provider)
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(
        coalesce(current_setting('request.jwt.claim.sub', true),
                 (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')),
        '')::uuid;
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- realtime
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS realtime;

CREATE TABLE IF NOT EXISTS realtime.messages (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic       text        NOT NULL,
    extension   text        NOT NULL,
    event       text,
    payload     jsonb,
    private     boolean     DEFAULT false,
    inserted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('realtime.topic', true), '');
$$;

CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO realtime.messages (topic, extension, event, payload, private)
    VALUES (topic, 'broadcast', event, payload, private);
END $$;

GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
GRANT SELECT, INSERT ON realtime.messages TO authenticated;
GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated, service_role;
