# Cambio de estado desde el panel web

Esta entrega parte de findfood-api-main.zip compartido el 6 de octubre de 2026. Mantiene POST /v1/admin/usuarios para crear ADMIN o ASESOR_BANCO y añade una ruta para el cambio solicitado:

```http
PATCH /v1/admin/usuarios/<UUID>/estado
Authorization: Bearer <token del ADMIN>
Content-Type: application/json

{"estado":"INACTIVO"}
```

Para activar, envía `{"estado":"ACTIVO"}`. Respuesta: `{"id":"<UUID>","estado":"INACTIVO"}` o ACTIVO.

Solo admite cuentas cuyo estado actual sea ACTIVO o INACTIVO. No permite inactivar la cuenta propia ni modificar cuentas eliminadas, suspendidas o pendientes de confirmación. Para activar exige teléfono y correo confirmado. Cambia estado y updated_by y registra auditoría dentro de la misma transacción. Una actualización concurrente incompatible devuelve 409. Si ya tiene el estado solicitado, devuelve el estado sin duplicar la auditoría. Al inactivar un voluntario, disponible pasa a false; activarlo no lo declara disponible automáticamente. AuthGuard verifica el estado en cada petición, por lo que los tokens existentes no permiten operar mientras la cuenta esté inactiva.

No se sustituye la suspensión por inactivación y no se modifica el alta actual de usuarios. No requiere migración; ambos estados ya existen en la base.

Archivos de implementación modificados:

- src/modulos/admin/admin.dto.ts
- src/modulos/admin/admin.controller.ts
- src/modulos/admin/usuarios-admin.service.ts

Pruebas añadidas:

- src/modulos/admin/usuarios-estado.spec.ts: cambios, auditoría, disponibilidad, protección propia, estados restringidos, confirmación, concurrencia y validación.
- src/modulos/admin/usuarios-http.spec.ts: contrato HTTP, roles, UUID, cuerpo y creación de ADMIN/ASESOR_BANCO. Identidad/persistencia simuladas; usa el RolesGuard real.

Conserva tu .env, ejecuta npm ci y reinicia con npm run start:dev. Para validar fuentes: npm run build, npm run lint y npm test -- --runInBand. No se modificaron tus tablas ni se efectuaron cambios en datos reales.
