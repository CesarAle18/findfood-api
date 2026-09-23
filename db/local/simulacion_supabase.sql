-- ============================================================================
--  SIMULACIÓN MÍNIMA DE SUPABASE PARA DESARROLLO LOCAL Y PRUEBAS
--
--  NO es una migración: nunca se aplica al proyecto real de Supabase (que ya
--  trae estos objetos). Recrea solo lo que el DDL de supabase/migrations/
--  necesita para cargar sin cambios en un PostgreSQL + PostGIS vacío:
--    * los roles anon, authenticated y service_role;
--    * auth.users (columnas que leen los disparadores) y auth.uid();
--    * realtime.messages, realtime.topic() y realtime.send().
-- ============================================================================

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

-- Supabase concede estos privilegios de fábrica; el DDL v3 los revoca.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email              varchar(255),
    encrypted_password varchar(255),
    email_confirmed_at timestamptz,
    raw_app_meta_data  jsonb,
    raw_user_meta_data jsonb,
    banned_until       timestamptz,
    created_at         timestamptz DEFAULT now(),
    updated_at         timestamptz DEFAULT now()
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
