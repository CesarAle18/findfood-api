-- ============================================================================
--  ESTADO DEL PRODUCTO EN LA RECOGIDA (API-10)
--
--  Al confirmar una parada RECOGIDA, la app móvil del voluntario registra el
--  estado en que recibe el producto: BUENO, REGULAR o MALO. Es opcional (las
--  confirmaciones anteriores quedan en NULL) y solo aplica a paradas RECOGIDA;
--  el backend rechaza el campo en una ENTREGA.
--
--  No crea tablas ni funciones (no aplica la regla de RLS de §13.1).
-- ============================================================================

CREATE TYPE estado_producto AS ENUM ('BUENO','REGULAR','MALO');

ALTER TABLE parada_ruta ADD COLUMN estado_producto estado_producto NULL;
