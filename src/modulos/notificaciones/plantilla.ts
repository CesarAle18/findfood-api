/** Sustituye {{clave}} por su valor; las claves sin valor quedan vacías. */
export function renderizarPlantilla(
  plantilla: string,
  variables: Record<string, string | number> = {},
): string {
  return plantilla
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, clave: string) =>
      clave in variables ? String(variables[clave]) : '',
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}
