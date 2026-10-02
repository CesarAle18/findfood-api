-- ============================================================================
--  EXTENSIONES EN EL ESQUEMA "extensions" (Supabase)
--
--  En Supabase, PostGIS, citext y pgcrypto viven en el esquema "extensions",
--  no en "public". app_backend no tenía ese esquema en su search_path ni
--  permiso USAGE sobre él, así que fn_candidatos_donacion y las consultas
--  geográficas de la API fallaban con
--    function st_dwithin(extensions.geography, ...) does not exist
--    type "geography" does not exist
--
--  No crea tablas ni funciones (no aplica la regla de RLS de §13.1).
--  El search_path del rol rige para las conexiones nuevas: tras aplicarla,
--  reinicia la API para que el pool abra conexiones nuevas.
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
        GRANT USAGE ON SCHEMA extensions TO app_backend;
    END IF;
END $$;

ALTER ROLE app_backend SET search_path = "$user", public, extensions;

-- El motor no depende del search_path de quien lo invoca.
ALTER FUNCTION fn_candidatos_donacion(uuid, numeric) SET search_path = public, extensions;
