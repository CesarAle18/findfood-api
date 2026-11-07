-- ============================================================================
--  SINCRONIZACIÓN EN TIEMPO REAL: DISPARADORES DEL FLUJO (API-2)
--
--  donacion, asignacion, parada_ruta y ruta avisan por usuario:<uuid> (evento
--  'sync', contrato v1 de 20261108000000_sincronizacion_canal_usuario.sql) a
--  quienes tienen el cambio en la app: el donante y los voluntarios.
--
--    * Disparadores AFTER ... FOR EACH ROW filtrados por columna: cambiar el
--      orden o la ETA de las paradas, o updated_at, no avisa.
--    * fn_rt_sincronizar deja un aviso por (usuario, entidad, id) en cada
--      transacción: aceptar recorre varios estados y el donante recibe uno.
--    * Un donante solo recibe { entidad: 'donacion', id } de sus donaciones.
--    * La flota del banco no usa la app: sin voluntario no hay aviso.
--    * fn_donacion_realtime (banco:donaciones, §19.1) no cambia.
--
--  Ver docs/arquitectura.md §9.4.
-- ============================================================================

-- El donante y los voluntarios con una oferta viva o la asignación aceptada.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar_donacion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_usuario uuid;
BEGIN
    FOR v_usuario IN
        SELECT dn.usuario_id FROM donante dn WHERE dn.id = NEW.donante_id
        UNION
        SELECT v.usuario_id
          FROM asignacion a
          JOIN voluntario v ON v.id = a.voluntario_id
         WHERE a.donacion_id = NEW.id
           AND a.estado IN ('OFRECIDA','ACEPTADA')
    LOOP
        PERFORM fn_rt_sincronizar(v_usuario,
                                  jsonb_build_object('entidad', 'donacion', 'id', NEW.id));
    END LOOP;
    RETURN NULL;
END $$;

-- El voluntario de la oferta. El donante solo cuando su donación gana o pierde
-- voluntario (entra en ACEPTADA o sale de ella): las ofertas no le cambian nada.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar_asignacion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM fn_rt_sincronizar(
        (SELECT v.usuario_id FROM voluntario v WHERE v.id = NEW.voluntario_id),
        jsonb_build_object('entidad', 'asignacion', 'id', NEW.id,
                           'donacion_id', NEW.donacion_id, 'ruta_id', NEW.ruta_id));

    IF NEW.estado = 'ACEPTADA' OR (TG_OP = 'UPDATE' AND OLD.estado = 'ACEPTADA') THEN
        PERFORM fn_rt_sincronizar(
            (SELECT dn.usuario_id
               FROM donacion d
               JOIN donante dn ON dn.id = d.donante_id
              WHERE d.id = NEW.donacion_id),
            jsonb_build_object('entidad', 'donacion', 'id', NEW.donacion_id));
    END IF;
    RETURN NULL;
END $$;

-- El voluntario de la ruta y los donantes cuyo seguimiento depende de la parada,
-- cada uno con su propia donación:
--   * el de la parada que cambió;
--   * los de las recogidas abiertas (PENDIENTE o EN_SITIO): cuentan las paradas
--     que tienen antes;
--   * los ya recogidos camino al banco: ven al voluntario solo cuando no quedan
--     recogidas ajenas abiertas (20261023000001_seguimiento_donante_privacidad.sql).
-- Las paradas no se borran: no hay disparador DELETE.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar_parada()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_recogida record;
BEGIN
    PERFORM fn_rt_sincronizar(
        (SELECT v.usuario_id
           FROM ruta r
           JOIN voluntario v ON v.id = r.voluntario_id
          WHERE r.id = NEW.ruta_id),
        jsonb_build_object('entidad', 'parada', 'id', NEW.id,
                           'ruta_id', NEW.ruta_id, 'donacion_id', NEW.donacion_id));

    FOR v_recogida IN
        SELECT DISTINCT dn.usuario_id, p.donacion_id
          FROM parada_ruta p
          JOIN donacion d ON d.id = p.donacion_id
          JOIN donante dn ON dn.id = d.donante_id
         WHERE p.ruta_id = NEW.ruta_id
           AND p.tipo = 'RECOGIDA'
           AND (p.id = NEW.id
                OR p.estado IN ('PENDIENTE','EN_SITIO')
                OR (p.estado = 'COMPLETADA'
                    AND d.estado IN ('ASIGNADA','EN_RECOLECCION','EN_TRANSITO')))
    LOOP
        PERFORM fn_rt_sincronizar(v_recogida.usuario_id,
                                  jsonb_build_object('entidad', 'donacion',
                                                     'id', v_recogida.donacion_id));
    END LOOP;
    RETURN NULL;
END $$;

-- El voluntario de la ruta. voluntario_id no cambia después de crearla.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar_ruta()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM fn_rt_sincronizar(
        (SELECT v.usuario_id FROM voluntario v WHERE v.id = NEW.voluntario_id),
        jsonb_build_object('entidad', 'ruta', 'id', NEW.id));
    RETURN NULL;
END $$;

-- Como tg_donacion_realtime_*: un BORRADOR solo lo ve su donante, que lo creó.
CREATE OR REPLACE TRIGGER tg_donacion_sincronizar_ins
    AFTER INSERT ON donacion
    FOR EACH ROW WHEN (NEW.estado <> 'BORRADOR')
    EXECUTE FUNCTION fn_rt_sincronizar_donacion();

CREATE OR REPLACE TRIGGER tg_donacion_sincronizar_upd
    AFTER UPDATE OF estado ON donacion
    FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado)
    EXECUTE FUNCTION fn_rt_sincronizar_donacion();

CREATE OR REPLACE TRIGGER tg_asignacion_sincronizar_ins
    AFTER INSERT ON asignacion
    FOR EACH ROW
    EXECUTE FUNCTION fn_rt_sincronizar_asignacion();

CREATE OR REPLACE TRIGGER tg_asignacion_sincronizar_upd
    AFTER UPDATE OF estado ON asignacion
    FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado)
    EXECUTE FUNCTION fn_rt_sincronizar_asignacion();

-- Solo el estado: aceptar reescribe orden y ETA de N paradas, una fila a la vez.
CREATE OR REPLACE TRIGGER tg_parada_sincronizar_ins
    AFTER INSERT ON parada_ruta
    FOR EACH ROW
    EXECUTE FUNCTION fn_rt_sincronizar_parada();

CREATE OR REPLACE TRIGGER tg_parada_sincronizar_upd
    AFTER UPDATE OF estado ON parada_ruta
    FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado)
    EXECUTE FUNCTION fn_rt_sincronizar_parada();

-- geometria: el trazado por calles llega después de aceptar (fuera de la transacción).
CREATE OR REPLACE TRIGGER tg_ruta_sincronizar_ins
    AFTER INSERT ON ruta
    FOR EACH ROW
    EXECUTE FUNCTION fn_rt_sincronizar_ruta();

CREATE OR REPLACE TRIGGER tg_ruta_sincronizar_upd
    AFTER UPDATE OF estado, geometria ON ruta
    FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado
                       OR NEW.geometria IS DISTINCT FROM OLD.geometria)
    EXECUTE FUNCTION fn_rt_sincronizar_ruta();

-- Solo como disparadores: corren como su dueño (el de las migraciones).
REVOKE ALL ON FUNCTION fn_rt_sincronizar_donacion()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_rt_sincronizar_asignacion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_rt_sincronizar_parada()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_rt_sincronizar_ruta()       FROM PUBLIC, anon, authenticated;
