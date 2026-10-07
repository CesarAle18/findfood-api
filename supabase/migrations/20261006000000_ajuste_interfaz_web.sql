-- ============================================================================
--  AJUSTE A LA INTERFAZ WEB
--
--  Quita columnas que ninguna interfaz (panel web ni app móvil) permite ver ni
--  editar y que ninguna lógica lee: solo se guardaban.
--
--  - almacen: temperaturas, horario de recepción, teléfono y ciudad. La web
--    configura nombre, dirección/ubicación, régimen, capacidad y estado.
--  - banco_alimentos: datos de contacto y operación sin uso. Se conservan
--    nombre, dirección, ciudad, ubicación y tiene_flota_propia (ruteo).
--  - suspension_cuenta: la web solo activa o inactiva cuentas, así que toda
--    suspensión es indefinida y sin motivo de catálogo (basta la descripción).
--
--  No crea tablas ni funciones (no aplica la regla de RLS de §13.1).
-- ============================================================================

ALTER TABLE almacen
    DROP CONSTRAINT ck_almacen_temperatura,
    DROP COLUMN temperatura_min,
    DROP COLUMN temperatura_max,
    DROP COLUMN horario_disponibilidad,
    DROP COLUMN telefono,
    DROP COLUMN ciudad;

ALTER TABLE banco_alimentos
    DROP CONSTRAINT uq_banco_documento,
    DROP CONSTRAINT ck_banco_capacidad,
    DROP COLUMN documento_fiscal,
    DROP COLUMN email,
    DROP COLUMN telefono,
    DROP COLUMN capacidad_total_kg,
    DROP COLUMN radio_operacion_km,
    DROP COLUMN horario_recepcion;

DROP INDEX uq_suspension_activa;
ALTER TABLE suspension_cuenta
    DROP CONSTRAINT ck_suspension_fechas,
    DROP CONSTRAINT fk_suspension_motivo,
    DROP COLUMN fin_at,
    DROP COLUMN motivo_id;
CREATE UNIQUE INDEX uq_suspension_activa
    ON suspension_cuenta (usuario_id) WHERE levantada_at IS NULL;
