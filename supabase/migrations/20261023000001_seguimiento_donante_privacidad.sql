-- ============================================================================
--  SEGUIMIENTO DEL DONANTE: PRIVACIDAD CAMINO AL BANCO (API-06)
--
--  Ajusta la ventana de 20261023000000_seguimiento_donante.sql en dos puntos.
--
--  1. Camino al banco (la recogida del donante ya está COMPLETADA) el donante no
--     escucha el canal ruta:<id> mientras otra parada RECOGIDA de la ruta siga
--     PENDIENTE o EN_SITIO. El voluntario va a recoger donaciones de otros
--     donantes y su posición, estando en una de ellas, revelaría esa dirección
--     (Ley 1581: mínimo necesario y privacidad de terceros). Cuando ya no quedan
--     recogidas abiertas, el canal se vuelve a abrir hasta la entrega. Hacia su
--     propio punto (PENDIENTE o EN_SITIO) no cambia nada.
--
--  2. La entrega que cierra la ventana es la ENTREGA de mayor orden de la ruta,
--     la misma que lee GET /v1/donaciones/{id}/seguimiento. Antes la función
--     aceptaba cualquier ENTREGA abierta y el endpoint miraba solo la última; hoy
--     las rutas tienen una sola ENTREGA, pero con varias divergían. Se elige la
--     de mayor orden porque es la llegada al banco con la que termina la ruta.
--
--  La regla es la misma que ventanaDonante() en
--  src/modulos/ruteo/seguimiento-donacion.ts (activo y posicion_visible); si
--  cambia una, cambia la otra. Los estados abiertos son PARADA_ABIERTA de ese
--  archivo.
--
--  No crea tablas ni funciones nuevas: reemplaza fn_rt_es_donante_de_ruta y la
--  política pol_rt_ruta_leer no cambia.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_rt_es_donante_de_ruta(p_ruta_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.ruta r
          JOIN public.parada_ruta p ON p.ruta_id = r.id AND p.tipo = 'RECOGIDA'
          JOIN public.donacion d    ON d.id = p.donacion_id
          JOIN public.donante dn    ON dn.id = d.donante_id
         WHERE r.id = p_ruta_id
           AND r.estado = 'EN_CURSO'
           AND p.estado IN ('PENDIENTE','EN_SITIO','COMPLETADA')
           AND d.estado IN ('ASIGNADA','EN_RECOLECCION','EN_TRANSITO')
           AND dn.usuario_id = auth.uid()
           AND (SELECT e.estado
                  FROM public.parada_ruta e
                 WHERE e.ruta_id = r.id
                   AND e.tipo = 'ENTREGA'
                 ORDER BY e.orden DESC
                 LIMIT 1) IN ('PENDIENTE','EN_SITIO')
           AND (p.estado <> 'COMPLETADA'
                OR NOT EXISTS (SELECT 1
                                 FROM public.parada_ruta o
                                WHERE o.ruta_id = r.id
                                  AND o.tipo = 'RECOGIDA'
                                  AND o.id <> p.id
                                  AND o.estado IN ('PENDIENTE','EN_SITIO'))));
$$;

-- CREATE OR REPLACE conserva los privilegios; se repiten para no depender de ello.
REVOKE ALL ON FUNCTION fn_rt_es_donante_de_ruta(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_rt_es_donante_de_ruta(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_rt_es_donante_de_ruta(uuid) TO app_backend;
