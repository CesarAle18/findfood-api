-- ============================================================================
--  DATOS DE PRUEBA PARA EL PROYECTO DE SUPABASE
--
--  NO es una migración: no va en supabase/migrations/ y nunca debe correr en
--  producción. Crea cuentas con una contraseña conocida.
--
--  Cómo ejecutarlo: SQL Editor de Supabase, el archivo completo, en una sola
--  corrida y sin texto seleccionado. Se puede repetir: no duplica nada.
--
--  Qué crea:
--    * 6 cuentas (contraseña de todas: FindFood-Pruebas-2026)
--        admin@findfood.test        ADMIN
--        asesor@findfood.test       ASESOR_BANCO (sin contraseña temporal)
--        donante@findfood.test      DONANTE
--        voluntario@findfood.test   DONANTE + VOLUNTARIO aprobado, camioneta refrigerada de 500 kg
--        voluntario2@findfood.test  DONANTE + VOLUNTARIO aprobado, automóvil de 150 kg sin frío
--        solicitante@findfood.test  DONANTE (para probar la solicitud de voluntario)
--    * El banco de alimentos, con flota propia, y dos sedes: Norte (SECO) y
--      Centro (REFRIGERADO).
--    * Tres lotes de arroz en la Sede Norte, con vencimientos distintos, para
--      probar la salida FEFO.
--    * Una donación en BORRADOR del donante, lista para publicar.
--
--  Las cuentas se insertan en auth.users y auth.identities como lo haría
--  Supabase Auth; los disparadores del DDL v3 crean el perfil, los roles y la
--  fila de donante. Para borrar todo: npx supabase db reset --linked
-- ============================================================================

BEGIN;

SET LOCAL search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Cuentas
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c    record;
    v_id uuid;
BEGIN
    FOR c IN
        SELECT * FROM (VALUES
            ('admin@findfood.test',       'Ada',     'Admin',      '+573000000001', '{"rol": "ADMIN"}'::jsonb),
            ('asesor@findfood.test',      'Andrés',  'Asesor',     '+573000000002', '{"rol": "ASESOR_BANCO"}'::jsonb),
            ('donante@findfood.test',     'Diana',   'Donante',    '+573000000003', '{}'::jsonb),
            ('voluntario@findfood.test',  'Víctor',  'Voluntario', '+573000000004', '{}'::jsonb),
            ('voluntario2@findfood.test', 'Valeria', 'Voluntaria', '+573000000005', '{}'::jsonb),
            ('solicitante@findfood.test', 'Sara',    'Solicitante','+573000000006', '{}'::jsonb)
        ) AS t(email, nombres, apellidos, telefono, app_meta)
    LOOP
        SELECT id INTO v_id FROM auth.users WHERE email = c.email;
        CONTINUE WHEN v_id IS NOT NULL;

        v_id := gen_random_uuid();
        -- Los campos de token van como '' y no NULL: Supabase Auth falla al leer NULL.
        INSERT INTO auth.users
            (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
             raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
             confirmation_token, recovery_token, email_change, email_change_token_new)
        VALUES
            ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
             c.email, crypt('FindFood-Pruebas-2026', gen_salt('bf')), now(),
             '{"provider": "email", "providers": ["email"]}'::jsonb || c.app_meta,
             jsonb_build_object('nombres', c.nombres, 'apellidos', c.apellidos,
                                'telefono', c.telefono, 'acepto_terminos', true),
             now(), now(), '', '', '', '');

        INSERT INTO auth.identities
            (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
        VALUES
            (gen_random_uuid(), v_id, v_id::text, 'email',
             jsonb_build_object('sub', v_id::text, 'email', c.email, 'email_verified', true),
             now(), now(), now());
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Voluntarios aprobados, disponibles toda la semana
-- ---------------------------------------------------------------------------
INSERT INTO voluntario
    (usuario_id, tipo_vehiculo_id, fecha_nacimiento, placa_vehiculo, url_foto_vehiculo,
     capacidad_carga_kg, tiene_refrigeracion, ubicacion_base, radio_cobertura_km,
     disponible, estado_verificacion, verificado_por, verificado_at)
SELECT u.id, tv.id, v.nacimiento::date, v.placa,
       'documentos-identidad/' || u.id || '/vehiculo.jpg',
       v.capacidad, v.frio, ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography, 20,
       true, 'APROBADA', adm.id, now()
  FROM (VALUES
          ('voluntario@findfood.test',  'CAMIONETA', '1992-03-15', 'PRB101', 500, true,  4.6553, -74.0816),
          ('voluntario2@findfood.test', 'AUTOMOVIL', '1996-08-02', 'PRB202', 150, false, 4.6380, -74.0840)
       ) AS v(email, vehiculo, nacimiento, placa, capacidad, frio, lat, lng)
  JOIN usuario u        ON u.email = v.email
  JOIN tipo_vehiculo tv ON tv.codigo = v.vehiculo
  JOIN usuario adm      ON adm.email = 'admin@findfood.test'
ON CONFLICT (usuario_id) DO NOTHING;

-- La solicitud aprobada que dejaría el flujo normal (§11, verificaciones).
INSERT INTO verificacion_identidad
    (usuario_id, url_documento_frente, estado, revisado_por, revisado_at)
SELECT u.id, 'documentos-identidad/' || u.id || '/documento.jpg', 'APROBADA', adm.id, now()
  FROM usuario u
  JOIN usuario adm ON adm.email = 'admin@findfood.test'
 WHERE u.email IN ('voluntario@findfood.test', 'voluntario2@findfood.test')
   AND NOT EXISTS (SELECT 1 FROM verificacion_identidad vi WHERE vi.usuario_id = u.id);

INSERT INTO usuario_rol (usuario_id, rol_id, activo)
SELECT u.id, r.id, true
  FROM usuario u
  JOIN rol r ON r.codigo = 'VOLUNTARIO'
 WHERE u.email IN ('voluntario@findfood.test', 'voluntario2@findfood.test')
ON CONFLICT (usuario_id, rol_id) DO UPDATE SET activo = true;

INSERT INTO voluntario_disponibilidad (voluntario_id, dia_semana, hora_inicio, hora_fin)
SELECT v.id, d, '00:00', '23:59'
  FROM voluntario v
  JOIN usuario u ON u.id = v.usuario_id
 CROSS JOIN generate_series(0, 6) AS d
 WHERE u.email IN ('voluntario@findfood.test', 'voluntario2@findfood.test')
ON CONFLICT (voluntario_id, dia_semana, hora_inicio)
DO UPDATE SET hora_fin = EXCLUDED.hora_fin, activo = true;

-- ---------------------------------------------------------------------------
-- 3. Banco y sedes
-- ---------------------------------------------------------------------------
INSERT INTO banco_alimentos (nombre, direccion, ciudad, ubicacion, tiene_flota_propia)
SELECT 'Banco de Alimentos de Bogotá (pruebas)', 'Calle 19 # 32-50', 'Bogotá',
       ST_SetSRID(ST_MakePoint(-74.0817, 4.6097), 4326)::geography, true
 WHERE NOT EXISTS (SELECT 1 FROM banco_alimentos WHERE deleted_at IS NULL);

INSERT INTO almacen (banco_id, nombre, direccion, ubicacion, tipo, capacidad_kg)
SELECT b.id, s.nombre, s.direccion,
       ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography,
       s.tipo::tipo_almacenamiento, s.capacidad
  FROM banco_alimentos b
 CROSS JOIN (VALUES
          ('Sede Norte',  'Autopista Norte # 170-20', 4.7480, -74.0450, 'SECO',        8000),
          ('Sede Centro', 'Calle 13 # 30-15',         4.6120, -74.0900, 'REFRIGERADO', 3000)
       ) AS s(nombre, direccion, lat, lng, tipo, capacidad)
 WHERE b.deleted_at IS NULL
ON CONFLICT (banco_id, nombre) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Inventario: tres lotes de arroz con vencimientos distintos (FEFO)
--    Cada lote nace con su ENTRADA en el libro mayor (§10).
-- ---------------------------------------------------------------------------
WITH nuevos AS (
    INSERT INTO lote_inventario
        (codigo_lote, banco_id, almacen_id, tipo_alimento_id, unidad_medida_id,
         cantidad_inicial, cantidad_disponible, peso_inicial_kg, peso_disponible_kg,
         fecha_vencimiento, created_by)
    SELECT l.codigo, a.banco_id, a.id, ta.id, um.id,
           l.kg, l.kg, l.kg, l.kg,
           (now() AT TIME ZONE 'America/Bogota')::date + l.dias, ase.id
      FROM (VALUES
              ('PRUEBA-ARROZ-01', 40, 5),
              ('PRUEBA-ARROZ-02', 25, 30),
              ('PRUEBA-ARROZ-03', 60, NULL::int)
           ) AS l(codigo, kg, dias)
      JOIN almacen a        ON a.nombre = 'Sede Norte'
      JOIN tipo_alimento ta ON ta.codigo = 'ARROZ'
      JOIN unidad_medida um ON um.codigo = 'KG'
      JOIN usuario ase      ON ase.email = 'asesor@findfood.test'
    ON CONFLICT (banco_id, codigo_lote) DO NOTHING
    RETURNING id, cantidad_inicial, peso_inicial_kg, created_by
)
INSERT INTO movimiento_inventario (lote_id, tipo, cantidad, peso_kg, saldo_cantidad, motivo, usuario_id)
SELECT id, 'ENTRADA', cantidad_inicial, peso_inicial_kg, cantidad_inicial, 'Datos de prueba', created_by
  FROM nuevos;

-- ---------------------------------------------------------------------------
-- 5. Una donación en BORRADOR, lista para publicar
--    La ventana empieza 10 min después de ejecutar este script y dura 4 h.
--    Si la publicas más tarde, actualiza la ventana con PATCH /v1/donaciones/{id}.
-- ---------------------------------------------------------------------------
WITH donacion_nueva AS (
    INSERT INTO donacion
        (codigo, donante_id, titulo, descripcion, peso_estimado_kg, requiere_refrigeracion,
         fecha_vencimiento_min, ventana_recogida_inicio, ventana_recogida_fin,
         direccion_recogida, referencia_recogida, ubicacion_recogida, created_by)
    SELECT 'DON-PRUEBA-0001', dn.id, 'Excedente de mercado (prueba)',
           'Arroz y pan de una tienda de barrio', 10, false,
           (now() AT TIME ZONE 'America/Bogota')::date + 2,
           now() + interval '10 minutes', now() + interval '250 minutes',
           'Calle 63 # 11-40', 'Portería del edificio',
           ST_SetSRID(ST_MakePoint(-74.0836, 4.6533), 4326)::geography, u.id
      FROM usuario u
      JOIN donante dn ON dn.usuario_id = u.id
     WHERE u.email = 'donante@findfood.test'
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id
),
historial AS (
    INSERT INTO historial_estado (ambito, donacion_id, estado_nuevo, motivo)
    SELECT 'DONACION', id, 'BORRADOR', 'Datos de prueba' FROM donacion_nueva
)
INSERT INTO donacion_item
    (donacion_id, tipo_alimento_id, unidad_medida_id, descripcion, cantidad,
     peso_estimado_kg, fecha_vencimiento)
SELECT d.id, ta.id, ta.unidad_medida_id, i.descripcion, i.cantidad, i.kg,
       (now() AT TIME ZONE 'America/Bogota')::date + i.dias
  FROM donacion_nueva d
 CROSS JOIN (VALUES
          ('ARROZ', 'Arroz blanco, bolsas de 1 kg', 6, 6, 200),
          ('PAN',   'Pan del día',                   4, 4, 2)
       ) AS i(tipo, descripcion, cantidad, kg, dias)
  JOIN tipo_alimento ta ON ta.codigo = i.tipo;

COMMIT;

-- ---------------------------------------------------------------------------
-- Resumen
-- ---------------------------------------------------------------------------
SELECT u.email,
       string_agg(r.codigo, ', ' ORDER BY r.codigo) FILTER (WHERE ur.activo) AS roles,
       u.estado,
       u.telefono
  FROM usuario u
  LEFT JOIN usuario_rol ur ON ur.usuario_id = u.id
  LEFT JOIN rol r ON r.id = ur.rol_id
 WHERE u.email LIKE '%@findfood.test'
 GROUP BY u.email, u.estado, u.telefono
 ORDER BY u.email;
