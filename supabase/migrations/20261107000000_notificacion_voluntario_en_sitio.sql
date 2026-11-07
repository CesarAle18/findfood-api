-- ============================================================================
--  AVISO DE LLEGADA A LA RECOGIDA
--
--  Cuando el voluntario registra la llegada a una parada RECOGIDA
--  (PENDIENTE → EN_SITIO), el donante recibe un aviso de que lo esperan en el
--  punto de recogida. En las rutas de la flota el colector es el banco.
--
--  Solo siembra un tipo de notificación: no crea tablas ni funciones (no aplica
--  la regla de RLS de §13.1). Idempotente por uq_tipo_notificacion_codigo.
-- ============================================================================

INSERT INTO tipo_notificacion (codigo, nombre, plantilla_titulo, plantilla_cuerpo, canal_default) VALUES
    ('VOLUNTARIO_EN_SITIO','Voluntario en el punto de recogida','El voluntario llegó',
     '{{voluntario}} está en el punto de recogida de tu donación.','PUSH')
ON CONFLICT (codigo) DO NOTHING;
