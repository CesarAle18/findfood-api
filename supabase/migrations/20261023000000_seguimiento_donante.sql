-- ============================================================================
--  SEGUIMIENTO DEL DONANTE HASTA LA ENTREGA (API-06)
--
--  El donante ve en vivo al voluntario en los dos tramos: hacia su punto de
--  recogida y luego hacia el banco, hasta que su donación se entrega. Antes
--  solo podía escuchar el canal ruta:<id> mientras su parada seguía PENDIENTE
--  o EN_SITIO y se le cortaba la señal al recoger.
--
--  Ley 1581 (finalidad y mínimo necesario): la finalidad pasa de "ver llegar al
--  voluntario" a "seguir la donación propia hasta que llega al banco". La
--  ventana sigue siendo acotada y se cierra sola:
--    * la ruta debe estar EN_CURSO;
--    * la parada RECOGIDA de su donación no puede haber fallado ni haberse
--      omitido (PENDIENTE, EN_SITIO o COMPLETADA);
--    * la donación sigue en la calle (ASIGNADA, EN_RECOLECCION o EN_TRANSITO);
--    * la ENTREGA de la ruta aún no se completa (PENDIENTE o EN_SITIO).
--  Confirmar la entrega completa la ruta y pasa la donación a ENTREGADA, así
--  que cualquiera de las condiciones basta para cerrar el acceso.
--
--  Realtime evalúa la política al unirse al canal y al refrescar el token: el
--  cliente debe cerrar el canal cuando el endpoint
--  GET /v1/donaciones/{id}/seguimiento responde activo = false.
--
--  La regla es la misma que ventanaDonante() en
--  src/modulos/ruteo/seguimiento-donacion.ts; si cambia una, cambia la otra.
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
           AND EXISTS (SELECT 1
                         FROM public.parada_ruta e
                        WHERE e.ruta_id = r.id
                          AND e.tipo = 'ENTREGA'
                          AND e.estado IN ('PENDIENTE','EN_SITIO')));
$$;

-- CREATE OR REPLACE conserva los privilegios; se repiten para no depender de ello.
REVOKE ALL ON FUNCTION fn_rt_es_donante_de_ruta(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_rt_es_donante_de_ruta(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_rt_es_donante_de_ruta(uuid) TO app_backend;
