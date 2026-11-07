-- ============================================================================
--  AVISOS A LOS AFECTADOS POR LO QUE HACEN OTROS
--
--  Hechos que cambiaban la donación, la oferta o la incidencia de alguien sin
--  avisarle. La API encola cada aviso en la transacción del hecho y nunca
--  avisa a quien lo provoca (docs/arquitectura.md §9.3):
--    * DONACION_CANCELADA_BANCO: el ADMIN canceló una donación ajena (donante).
--    * DONACION_REPUBLICADA: la donación vuelve a PUBLICADA para otro
--      voluntario (reasignación, abandono con margen, ruta de la flota
--      cancelada). Sin margen expira y solo llega DONACION_EXPIRADA.
--    * RECOGIDA_FALLIDA: su recogida quedó FALLIDA (donante). La donación
--      sigue abierta hasta que el personal la cancele o la reasigne.
--    * ASIGNACION_TOMADA: otro voluntario aceptó primero (cada voluntario con
--      oferta viva, con su propia asignación).
--    * ASIGNACION_RETIRADA: el personal puso la donación en una ruta de la
--      flota del banco (cada voluntario con oferta viva, con su propia
--      asignación).
--    * INCIDENCIA_REPORTADA: incidencia nueva (personal ACTIVO). IN_APP como
--      ALERTA_VENCIMIENTO: el personal usa el panel web, sin dispositivos push.
--    * INCIDENCIA_EN_REVISION, INCIDENCIA_RESUELTA: a quien la reportó.
--
--  Solo siembra tipos de notificación: no crea tablas ni funciones (no aplica
--  la regla de RLS de §13.1). Idempotente por uq_tipo_notificacion_codigo.
-- ============================================================================

INSERT INTO tipo_notificacion (codigo, nombre, plantilla_titulo, plantilla_cuerpo, canal_default) VALUES
    ('DONACION_CANCELADA_BANCO','Donación cancelada por el banco','Tu donación fue cancelada',
     'El banco de alimentos canceló la donación {{codigo}}. Motivo: {{motivo}}.','PUSH'),
    ('DONACION_REPUBLICADA','Donación publicada de nuevo','Buscamos otro voluntario',
     'La donación {{codigo}} volvió a publicarse para que otro voluntario la recoja.','PUSH'),
    ('RECOGIDA_FALLIDA','Recogida fallida','No se pudo recoger tu donación',
     'La recogida de la donación {{codigo}} no pudo completarse. El banco de alimentos revisará el caso.','PUSH'),
    ('ASIGNACION_TOMADA','Oferta tomada por otro voluntario','Otro voluntario tomó la recolección',
     'La donación {{codigo}} ya fue aceptada por otro voluntario.','PUSH'),
    ('ASIGNACION_RETIRADA','Oferta tomada por la flota del banco','La recolección ya no está disponible',
     'La donación {{codigo}} será recogida por el banco de alimentos.','PUSH'),
    ('INCIDENCIA_REPORTADA','Incidencia nueva','Nueva incidencia',
     'Se reportó la incidencia {{codigo}}: {{tipo}} (nivel {{nivel}}).','IN_APP'),
    ('INCIDENCIA_EN_REVISION','Incidencia en revisión','Tu reporte está en revisión',
     'El banco de alimentos está revisando la incidencia {{codigo}}.','PUSH'),
    ('INCIDENCIA_RESUELTA','Incidencia resuelta','Tu reporte fue resuelto',
     'La incidencia {{codigo}} fue resuelta. Resolución: {{resolucion}}','PUSH')
ON CONFLICT (codigo) DO NOTHING;
