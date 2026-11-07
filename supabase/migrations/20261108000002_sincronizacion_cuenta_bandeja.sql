-- ============================================================================
--  SINCRONIZACIÓN EN TIEMPO REAL: BANDEJA Y CUENTA (API-3)
--
--  notificacion, usuario, usuario_rol y voluntario avisan por usuario:<uuid>
--  (evento 'sync', contrato v1 de 20261108000000_sincronizacion_canal_usuario.sql)
--  solo a la persona dueña de la fila.
--
--    * notificacion: solo al nacer. El envío del push (estado_envio, intentos,
--      enviada_at) y marcar leída (leida_at) no avisan.
--    * La cuenta ({ entidad: 'cuenta', id: <su usuario> }) avisa cuando cambia
--      lo que decide qué puede hacer: estado, contraseña temporal, roles y
--      perfil de voluntario. Nunca por ultimo_acceso_at (AuthGuard), la
--      ubicación del voluntario, sus contadores, su calificación ni updated_at.
--    * fn_rt_sincronizar deja un aviso por (usuario, entidad, id) en cada
--      transacción: aprobar una verificación cambia el rol y el perfil, y la
--      persona recibe un solo aviso de cuenta.
--
--  Ver docs/arquitectura.md §9.4.
-- ============================================================================

-- La notificación nueva, a su destinatario. tipo es el código del catálogo,
-- el mismo que la bandeja devuelve por REST.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar_notificacion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM fn_rt_sincronizar(
        NEW.usuario_id,
        jsonb_build_object('entidad', 'notificacion', 'id', NEW.id,
                           'tipo', (SELECT t.codigo
                                      FROM tipo_notificacion t
                                     WHERE t.id = NEW.tipo_notificacion_id),
                           'donacion_id', NEW.donacion_id,
                           'asignacion_id', NEW.asignacion_id));
    RETURN NULL;
END $$;

-- La propia cuenta. En usuario la persona es la fila; en usuario_rol y
-- voluntario, su usuario_id. plpgsql prepara cada sentencia al ejecutarla, así
-- que NEW.usuario_id no se evalúa sobre usuario.
CREATE OR REPLACE FUNCTION fn_rt_sincronizar_cuenta()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_usuario uuid;
BEGIN
    IF TG_TABLE_NAME = 'usuario' THEN
        v_usuario := NEW.id;
    ELSE
        v_usuario := NEW.usuario_id;
    END IF;
    PERFORM fn_rt_sincronizar(v_usuario,
                              jsonb_build_object('entidad', 'cuenta', 'id', v_usuario));
    RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER tg_notificacion_sincronizar_ins
    AFTER INSERT ON notificacion
    FOR EACH ROW
    EXECUTE FUNCTION fn_rt_sincronizar_notificacion();

-- El alta (INSERT) no avisa: nadie escucha todavía y el rol inicial llega por
-- usuario_rol. El AuthGuard escribe ultimo_acceso_at hasta cada 5 minutos.
CREATE OR REPLACE TRIGGER tg_usuario_sincronizar_upd
    AFTER UPDATE OF estado, debe_cambiar_password, deleted_at ON usuario
    FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado
                       OR NEW.debe_cambiar_password IS DISTINCT FROM OLD.debe_cambiar_password
                       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
    EXECUTE FUNCTION fn_rt_sincronizar_cuenta();

-- Los roles no se borran: se desactivan (activo).
CREATE OR REPLACE TRIGGER tg_usuario_rol_sincronizar_ins
    AFTER INSERT ON usuario_rol
    FOR EACH ROW
    EXECUTE FUNCTION fn_rt_sincronizar_cuenta();

CREATE OR REPLACE TRIGGER tg_usuario_rol_sincronizar_upd
    AFTER UPDATE OF activo ON usuario_rol
    FOR EACH ROW WHEN (NEW.activo IS DISTINCT FROM OLD.activo)
    EXECUTE FUNCTION fn_rt_sincronizar_cuenta();

-- Volver a solicitar tras un rechazo es un INSERT ... ON CONFLICT DO UPDATE:
-- avisa el disparador UPDATE.
CREATE OR REPLACE TRIGGER tg_voluntario_sincronizar_ins
    AFTER INSERT ON voluntario
    FOR EACH ROW
    EXECUTE FUNCTION fn_rt_sincronizar_cuenta();

-- POST /voluntario/ubicacion escribe ultima_ubicacion* cada pocos minutos.
CREATE OR REPLACE TRIGGER tg_voluntario_sincronizar_upd
    AFTER UPDATE OF estado_verificacion, disponible, deleted_at ON voluntario
    FOR EACH ROW WHEN (NEW.estado_verificacion IS DISTINCT FROM OLD.estado_verificacion
                       OR NEW.disponible IS DISTINCT FROM OLD.disponible
                       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
    EXECUTE FUNCTION fn_rt_sincronizar_cuenta();

-- Solo como disparadores: corren como su dueño (el de las migraciones).
REVOKE ALL ON FUNCTION fn_rt_sincronizar_notificacion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_rt_sincronizar_cuenta()       FROM PUBLIC, anon, authenticated;
