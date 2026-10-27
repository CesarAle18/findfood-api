-- ============================================================================
--  OFERTA SIMULTÁNEA
--
--  Antes: una sola oferta viva por donación (uq_asignacion_vigente) y cascada
--  voluntario por voluntario. Ahora la donación se ofrece al mismo tiempo a
--  todos los voluntarios elegibles; el primero que acepta se la queda y las
--  demás ofertas se cierran.
--
--  Invariantes nuevas:
--    * uq_asignacion_aceptada: una donación tiene a lo sumo UNA asignación
--      ACEPTADA (nunca dos voluntarios con la misma donación).
--    * uq_asignacion_ofrecida: un voluntario tiene a lo sumo UNA oferta viva
--      (OFRECIDA) por donación.
--
--  Cada oferta vence con la publicación (expira_publicacion_at); el parámetro
--  ASIGNACION_TIMEOUT_MIN ya no se usa.
-- ============================================================================

DROP INDEX IF EXISTS uq_asignacion_vigente;

CREATE UNIQUE INDEX uq_asignacion_aceptada
    ON asignacion (donacion_id) WHERE estado = 'ACEPTADA';

CREATE UNIQUE INDEX uq_asignacion_ofrecida
    ON asignacion (donacion_id, voluntario_id) WHERE estado = 'OFRECIDA';

UPDATE parametro_sistema
   SET descripcion = 'EN DESUSO: las ofertas son simultáneas y vencen con la publicación (PUBLICACION_TIMEOUT_MIN)'
 WHERE clave = 'ASIGNACION_TIMEOUT_MIN';
