import { recrearBaseDePruebas } from './base-de-pruebas';

export default async function globalSetup(): Promise<void> {
  await recrearBaseDePruebas();
}
