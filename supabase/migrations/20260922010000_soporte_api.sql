-- ============================================================================
--  SOPORTE PARA LA API — complemento del DDL v3
--
--  No crea tablas (la regla de RLS de docs/arquitectura.md §13.1 no aplica).
--  Cubre lo que la implementación de la API necesitó y el DDL v3 no traía:
--    1. Tipos de notificación de verificación, cancelación y recepción.
--    2. Motivos adicionales, incluido OTRO (con comentario) por ámbito.
--    3. Catálogo inicial de tipo_alimento: sin él no se puede crear ninguna
--       donación. Los administradores lo amplían desde la API.
--    4. DELETE sobre donacion_item para app_backend. La API solo borra
--       productos de donaciones en BORRADOR o EXPIRADA (edición del borrador);
--       es la misma categoría de dato desechable que el ADR-10 exceptúa.
--    5. fn_preparar_baja_sin_confirmar: la retención de cuentas sin confirmar
--       (§7, tarea cuentas_sin_confirmar) borra el usuario en auth.users, lo
--       que propaga el borrado a usuario. Pero el alta crea siempre una fila en
--       donante, cuya FK hacia usuario es ON DELETE RESTRICT, así que el borrado
--       fallaría. Esta función elimina esa fila solo si la cuenta nunca confirmó
--       el correo y no tiene donaciones ni perfil de voluntario.
-- ============================================================================

-- 1. Tipos de notificación ---------------------------------------------------
INSERT INTO tipo_notificacion (codigo, nombre, plantilla_titulo, plantilla_cuerpo, canal_default) VALUES
    ('VERIFICACION_APROBADA','Verificación aprobada','Ya eres voluntario',
     'Tu solicitud fue aprobada. Activa tu disponibilidad para recibir ofertas de recolección.','PUSH'),
    ('VERIFICACION_RECHAZADA','Verificación rechazada','Tu solicitud de voluntario fue rechazada',
     'Motivo: {{motivo}}. Puedes enviar una nueva solicitud.','PUSH'),
    ('DONACION_CANCELADA','Recolección cancelada','Recolección cancelada',
     'La donación {{codigo}} fue cancelada y ya no debes recogerla.','PUSH'),
    ('DONACION_RECIBIDA','Donación recibida','Tu donación fue recibida',
     'El banco de alimentos recibió {{kg}} kg de tu donación. ¡Gracias!','PUSH'),
    ('DONACION_RECHAZADA','Donación rechazada en recepción','Tu donación no pudo recibirse',
     'El banco no pudo recibir tu donación. Motivo: {{motivo}}.','PUSH')
ON CONFLICT (codigo) DO NOTHING;

-- 2. Motivos -----------------------------------------------------------------
INSERT INTO motivo (ambito, codigo, nombre, requiere_comentario) VALUES
    ('RECHAZO_ASIGNACION','OTRO','Otro motivo', true),
    ('ABANDONO_ASIGNACION','VEHICULO','Problema con el vehículo', false),
    ('ABANDONO_ASIGNACION','OTRO','Otro motivo', true),
    ('CANCELACION_DONACION','CAMBIO_DE_PLANES','Ya no puedo entregar la donación', false),
    ('CANCELACION_DONACION','CANCELADA_POR_BANCO','Cancelada por el banco de alimentos', true),
    ('CANCELACION_DONACION','OTRO','Otro motivo', true),
    ('RECHAZO_RECEPCION','OTRO','Otro motivo', true),
    ('RECHAZO_VERIFICACION','DOC_NO_COINCIDE','Los documentos no coinciden con los datos registrados', false),
    ('RECHAZO_VERIFICACION','OTRO','Otro motivo', true)
ON CONFLICT (ambito, codigo) DO NOTHING;

-- 3. Catálogo inicial de tipos de alimento -----------------------------------
INSERT INTO tipo_alimento (categoria_alimento_id, unidad_medida_id, codigo, nombre,
                           requiere_refrigeracion, tipo_almacenamiento, perecedero, vida_util_dias)
SELECT c.id, u.id, v.codigo, v.nombre, v.refrigera, v.almacenamiento::tipo_almacenamiento, v.perecedero, v.vida
  FROM (VALUES
        ('FRUTAS_VERDURAS','KG','FRUTAS','Frutas',                         false,'SECO',        true,    7),
        ('FRUTAS_VERDURAS','KG','VERDURAS','Verduras y hortalizas',        false,'SECO',        true,    7),
        ('LACTEOS','L','LECHE','Leche',                                    true, 'REFRIGERADO', true,   10),
        ('LACTEOS','KG','QUESO','Quesos',                                  true, 'REFRIGERADO', true,   20),
        ('LACTEOS','UN','YOGUR','Yogur y bebidas lácteas',                 true, 'REFRIGERADO', true,   15),
        ('CARNICOS','KG','CARNE_RES','Carne de res',                       true, 'REFRIGERADO', true,    3),
        ('CARNICOS','KG','POLLO','Pollo',                                  true, 'REFRIGERADO', true,    3),
        ('PANADERIA','KG','PAN','Pan',                                     false,'SECO',        true,    3),
        ('NO_PERECEDEROS','KG','ARROZ','Arroz',                            false,'SECO',        false, 365),
        ('NO_PERECEDEROS','KG','GRANOS','Granos secos',                    false,'SECO',        false, 365),
        ('NO_PERECEDEROS','UN','ENLATADOS','Enlatados',                    false,'SECO',        false, 730),
        ('NO_PERECEDEROS','L','ACEITE','Aceite',                           false,'SECO',        false, 365),
        ('PREPARADOS','KG','COMIDA_PREPARADA','Comida preparada',          true, 'REFRIGERADO', true,    1)
       ) AS v(categoria, unidad, codigo, nombre, refrigera, almacenamiento, perecedero, vida)
  JOIN categoria_alimento c ON c.codigo = v.categoria
  JOIN unidad_medida u      ON u.codigo = v.unidad
ON CONFLICT (codigo) DO NOTHING;

-- 4. Edición de borradores ---------------------------------------------------
GRANT DELETE ON donacion_item TO app_backend;

-- 5. Retención de cuentas sin confirmar --------------------------------------
CREATE OR REPLACE FUNCTION fn_preparar_baja_sin_confirmar(p_usuario_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users u
                    WHERE u.id = p_usuario_id AND u.email_confirmed_at IS NULL) THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM public.donacion d
                 JOIN public.donante dn ON dn.id = d.donante_id
                WHERE dn.usuario_id = p_usuario_id)
       OR EXISTS (SELECT 1 FROM public.voluntario WHERE usuario_id = p_usuario_id) THEN
        RETURN false;
    END IF;
    DELETE FROM public.donante WHERE usuario_id = p_usuario_id;
    RETURN true;
END $$;

REVOKE ALL ON FUNCTION fn_preparar_baja_sin_confirmar(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_preparar_baja_sin_confirmar(uuid) TO app_backend;
