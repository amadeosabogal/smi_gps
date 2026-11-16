// Identificador de este dispositivo (una instalación de la app o un navegador). Se genera una vez y se envía en la
// cabecera X-Device-Id: el servidor ata cada turno al dispositivo que marcó la entrada, y solo ese envía la ubicación.
const CLAVE = 'smi_device_id';
let enMemoria: string | null = null;

const generar = (): string => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* se usa el respaldo */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};

export function getDeviceId(): string {
  if (enMemoria) return enMemoria;
  try {
    let id = localStorage.getItem(CLAVE);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = generar();
      localStorage.setItem(CLAVE, id);
    }
    enMemoria = id;
  } catch {
    // Sin almacenamiento (modo privado): vale mientras dure la página
    enMemoria = generar();
  }
  return enMemoria;
}
