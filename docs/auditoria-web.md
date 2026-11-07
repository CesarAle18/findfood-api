# Consulta de auditorías para el panel

`GET /v1/admin/auditoria` requiere un Bearer token de un usuario ADMIN. Consulta registros de todos los actores, incluidos ASESOR_BANCO, DONANTE, VOLUNTARIO y operaciones del sistema.

Compatible con `loadGlobalAudit` y `AuditLive` de la rama `Conexion_Back` del frontend: no requiere modificar esos componentes. La exportación CSV, indicadores y filtros de actor, rol, módulo y acción se calculan en el frontend después de cargar todas las páginas.

Parámetros opcionales:

- `desde`: ISO 8601, inclusivo.
- `hasta`: ISO 8601, exclusivo. El frontend envía el inicio del día siguiente para incluir el último día completo en Colombia.
- `limite`: 1–100, por defecto 20.
- `desplazamiento`: entero no negativo, por defecto 0.
- `usuario_id`: UUID del actor.
- `rol`: ADMIN, ASESOR_BANCO, DONANTE o VOLUNTARIO.
- `entidad`: nombre exacto de la entidad auditada, por ejemplo `usuario`.
- `accion`: código exacto, por ejemplo `CREAR`, `ACTUALIZAR`, `RECHAZAR`.

Ejemplo: `/v1/admin/auditoria?desde=2026-11-01T05:00:00Z&hasta=2026-11-04T05:00:00Z&limite=100&desplazamiento=0`.

Respuesta:

```json
{
  "datos": [{
    "id": "123",
    "fecha": "2026-11-03T15:30:00.000Z",
    "actor": "Ana Pérez",
    "usuario_id": "d53243ce-5472-4ab1-84b7-e7ea563d9e36",
    "roles": ["ASESOR_BANCO"],
    "modulo": "Almacenes",
    "accion": "ACTUALIZAR",
    "entidad": "almacen",
    "metodo": "",
    "descripcion": "actualizar almacen (referencia).",
    "detalles": {
      "id": "referencia",
      "valores_anteriores": "{\"nombre\":\"Anterior\"}",
      "valores_nuevos": "{\"nombre\":\"Nuevo\"}"
    }
  }],
  "total": 1,
  "limite": 100,
  "desplazamiento": 0
}
```

Los identificadores de auditoría son strings para conservar precisión y cumplir el parser del frontend. `metodo` está vacío porque la tabla no guarda el método HTTP. Los detalles son strings para el visor existente. Los nombres y roles corresponden al perfil actual, no a una instantánea histórica.

Se consulta la tabla `auditoria` existente, sin migraciones. Los cambios guardados exclusivamente en `historial_estado` no aparecen en este endpoint. No se generan auditorías retroactivas ni se registran lecturas del reporte. La paginación ordena por fecha e ID descendentes y cuenta registros con los mismos filtros dentro de una transacción de lectura consistente. El frontend fija `hasta` y limita la carga a 10.000 registros: para períodos mayores se debe reducir el rango.

Errores: 400 para filtros o rangos inválidos, 401 sin autenticación válida, 403 sin rol ADMIN.
