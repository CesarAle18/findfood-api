-- ============================================================================
--  UNIDADES ML Y G
--
--  La app móvil ofrece KG, L, ML y G al registrar productos de una donación.
--  KG y L ya existen; se agregan Mililitro y Gramo para que cada unidad de la
--  app tenga su unidad_medida_id. factor_a_kg sigue el criterio de L (1 L =
--  1 kg, densidad del agua): 1 ML = 0,001 kg y 1 G = 0,001 kg.
--
--  Solo inserta datos; es idempotente por la unicidad de codigo.
--  No crea tablas ni funciones (no aplica la regla de RLS de §13.1).
-- ============================================================================

INSERT INTO unidad_medida (codigo, nombre, factor_a_kg) VALUES
    ('ML', 'Mililitro', 0.001),
    ('G', 'Gramo', 0.001)
ON CONFLICT (codigo) DO NOTHING;
