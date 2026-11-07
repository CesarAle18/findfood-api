-- ============================================================================
--  SINCRONIZACIÓN EN TIEMPO REAL: CANAL PRIVADO POR USUARIO (API-1)
--
--  Añade el tópico privado de Realtime usuario:<uuid>, evento 'sync', para que
--  la app móvil se entere de los cambios que hacen otros (el personal en el
--  panel, otros voluntarios, las tareas programadas) sin salir de la pantalla.
--  Cada mensaje es solo un aviso de invalidación: la app vuelve a pedir el
--  recurso por REST, donde la API aplica roles y propiedad.
--
--  Crea el canal, su autorización y la función que emite. Los disparadores que
--  la llaman llegan en migraciones posteriores. banco:donaciones y ruta:<uuid>
--  (DDL v3, §19) no cambian.
--
--  Contrato del mensaje, versión 1 (payload del evento 'sync'):
--    { v: 1,
--      entidad: 'donacion' | 'asignacion' | 'parada' | 'ruta' | 'notificacion' | 'cuenta',
--      id?, donacion_id?, ruta_id?, asignacion_id?, tipo? }
--    * Solo identificadores para saber qué volver a pedir: sin datos de
--      negocio y sin estado.
--    * Las claves nulas no viajan.
--    * Un donante nunca recibe ids de las donaciones de otros donantes.
--
--  Ver docs/arquitectura.md §9.4.
-- ============================================================================

-- Uuid del tópico usuario:<uuid> (en minúsculas, sin sufijos); NULL si no lo es.
CREATE OR REPLACE FUNCTION fn_rt_usuario_id(p_topic text)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    IF p_topic ~ '^usuario:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN substr(p_topic, 9)::uuid;
    END IF;
    RETURN NULL;
END $$;

-- Quien pregunta (auth.uid()) tiene la cuenta ACTIVA y no eliminada. Como las
-- demás auxiliares de §19.2, no recibe el uuid: por /rpc solo informa sobre sí.
CREATE OR REPLACE FUNCTION fn_rt_es_usuario_activo()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.usuario u
         WHERE u.id = auth.uid()
           AND u.estado = 'ACTIVO'
           AND u.deleted_at IS NULL);
$$;

-- Emite un aviso 'sync' a usuario:<p_usuario_id>. La llaman solo disparadores
-- SECURITY DEFINER, así que app_backend no necesita permisos sobre realtime.
--   * Sin usuario (p. ej. una donación sin voluntario) no hace nada.
--   * Pone la versión del contrato si falta y quita las claves nulas.
--   * Una transacción que toca la misma fila varias veces avisa una sola vez
--     por (usuario, entidad, id). Los ya enviados se guardan en la variable
--     findfood.rt_sincronizados, local a la transacción (set_config(..., true)):
--     se vacía al confirmar o deshacer.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar(p_usuario_id uuid, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_payload  jsonb;
    v_clave    text;
    v_enviados jsonb;
BEGIN
    IF p_usuario_id IS NULL THEN
        RETURN;
    END IF;

    v_payload := jsonb_strip_nulls(jsonb_build_object('v', 1) || coalesce(p_payload, '{}'));
    -- Arreglo JSON como clave: no hay ambigüedad aunque falte alguna parte.
    v_clave := jsonb_build_array(p_usuario_id, v_payload->>'entidad', v_payload->>'id')::text;
    -- Fuera de la transacción que la fijó, la variable vale '' (no NULL).
    v_enviados := coalesce(nullif(current_setting('findfood.rt_sincronizados', true), ''), '{}')::jsonb;
    IF v_enviados ? v_clave THEN
        RETURN;
    END IF;

    PERFORM set_config('findfood.rt_sincronizados',
                       (v_enviados || jsonb_build_object(v_clave, true))::text,
                       true);
    PERFORM realtime.send(v_payload, 'sync', 'usuario:' || p_usuario_id, true);
END $$;

-- Solo el dueño del tópico, mientras su cuenta esté ACTIVA y no eliminada.
-- Realtime lo evalúa al unirse al canal y al refrescar el token (§9.2).
-- No hay política INSERT para usuario:<uuid>: ningún cliente emite en él.
-- pol_rt_ruta_emitir tampoco lo cubre (fn_rt_ruta_id devuelve NULL).
DROP POLICY IF EXISTS pol_rt_usuario_leer ON realtime.messages;

CREATE POLICY pol_rt_usuario_leer ON realtime.messages
    FOR SELECT TO authenticated
    USING (realtime.messages.extension = 'broadcast'
           AND public.fn_rt_usuario_id(realtime.topic()) = auth.uid()
           AND public.fn_rt_es_usuario_activo());

-- CREATE OR REPLACE conserva los privilegios; se fijan para no depender de ello.
-- Las auxiliares de la política son la excepción de §20: authenticated las
-- necesita para evaluarla.
REVOKE ALL ON FUNCTION fn_rt_usuario_id(text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_rt_es_usuario_activo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_rt_usuario_id(text)    TO authenticated, app_backend;
GRANT EXECUTE ON FUNCTION fn_rt_es_usuario_activo() TO authenticated, app_backend;

-- Nadie más la ejecuta: los disparadores corren como su dueño (el de las
-- migraciones), que no necesita permiso.
REVOKE ALL ON FUNCTION fn_rt_sincronizar(uuid, jsonb) FROM PUBLIC, anon, authenticated;
