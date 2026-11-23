export interface Usuario {
  id: number;
  codigo_empleado: string;
  dni?: string | null; // documento con el que el trabajador ingresa a la app
  nombre: string;
  correo: string;
  rol: 'administrador' | 'supervisor' | 'trabajador';
  cargo: string;
  telefono?: string;
  activo: boolean;
  foto_ref_bytes?: number; // tamaño de la foto de referencia (0 = sin foto); la imagen se pide aparte
  facial_enrolado?: boolean;
  privacidad_aceptada_en?: string | null; // cuándo aceptó la versión vigente del aviso de privacidad (null = pendiente)
}

export interface EstacionTrabajo {
  id: number;
  codigo: string;
  nombre: string;
  latitud: number;
  longitud: number;
  radio_metros: number;
  color: string;
  descripcion?: string;
  activo: boolean;
}

export interface RegistroAsistencia {
  id: number;
  usuario_id: number;
  nombre_usuario?: string;
  codigo_empleado?: string;
  cargo?: string;
  hora_ingreso: string;
  hora_salida: string | null;
  latitud_ingreso: number;
  longitud_ingreso: number;
  precision_ingreso?: number;
  estacion_ingreso_nombre?: string;
  latitud_salida?: number;
  longitud_salida?: number;
  precision_salida?: number;
  estacion_salida_nombre?: string;
  tiene_foto_ingreso?: boolean;
  tiene_foto_salida?: boolean;
  foto_ref_bytes?: number;
  similitud_facial?: number | null;
  verificacion_facial_exitosa?: boolean | null;
  metodo_validacion?: string | null;
  estado: 'activo' | 'completado';
  horas_totales: number | null;
  notas?: string;
  almuerzo_id?: number | null;
  almuerzo_inicio?: string | null;
  almuerzo_fin?: string | null;
}

export interface AuditoriaFraudeFacial {
  id: number;
  usuario_id: number;
  nombre_usuario?: string;
  codigo_empleado?: string;
  cargo?: string;
  fecha_intento: string;
  tipo_evento: string;
  tiene_foto_intento?: boolean;
  similitud_obtenida?: number | null;
  latitud?: number | null;
  longitud?: number | null;
  notas?: string | null;
}

export interface DatosTrabajadorEnVivo {
  usuario_id: number;
  codigo_empleado: string;
  nombre_usuario: string;
  cargo: string;
  telefono?: string;
  asistencia_id: number | null;
  hora_ingreso: string | null;
  tiene_foto_ingreso?: boolean;
  push_activo?: boolean | number; // ¿tiene las alertas activadas en su celular?
  segundos_sin_ping?: number | null; // antigüedad de la última señal GPS recibida
  gps_imprecisa?: boolean; // el celular está enviando una ubicación demasiado imprecisa
  en_almuerzo?: boolean; // está en su almuerzo (el GPS sigue registrándose)
  almuerzo_segundos?: number | null; // desde hace cuánto
  almuerzo_inicio?: string | null;
  bateria?: number | null; // % de batería del teléfono (solo app Android)
  cargando?: boolean | number | null; // ¿está conectado al cargador?
  estado_asistencia: 'activo' | null;
  latitud: number | null;
  longitud: number | null;
  precision: number | null;
  ultimo_ping: string | null;
  dentro_de_estacion: boolean | null;
  estacion_id: number | null;
  estacion_nombre: string | null;
  estacion_codigo: string | null;
  estacion_color: string | null;
}

export interface ResumenDashboard {
  totalTrabajadores: number;
  activosConteo: number;
  dentroEstacionConteo: number;
  fueraEstacionConteo: number;
  almuerzoConteo?: number;
}

// Modo "colocar estación en el mapa": el administrador marca el punto con el cursor y ajusta el radio
export interface ColocacionEstacion {
  activo: boolean;
  punto: { lat: number; lng: number } | null;
  radio: number;
  color: string;
}

export interface CambioColocacion {
  lat?: number;
  lng?: number;
  radio?: number;
}

// Recorrido de un turno (puntos GPS guardados entre la entrada y la salida)
export interface PuntoRecorrido {
  lat: number;
  lng: number;
  precision: number | null;
  estacionId: number | null;
  fecha: string;
  bateria?: number | null;
  cargando?: boolean | null;
}

export interface AlmuerzoTurno {
  id: number;
  inicio_en: string;
  fin_en: string | null;
  cierre: string | null;
  foto_inicio: number;
  foto_fin: number;
}

export interface RecorridoTurno {
  ahora: string;
  almuerzoMinutos?: number;
  almuerzos?: AlmuerzoTurno[];
  asistencia: {
    id: number;
    usuario_id: number;
    nombre_usuario: string;
    codigo_empleado: string;
    cargo?: string;
    hora_ingreso: string;
    hora_salida: string | null;
    estado: 'activo' | 'completado';
  };
  puntos: PuntoRecorrido[];
}

// Qué se está verificando con el rostro (cada uno tiene su propio ticket de un solo uso en el servidor)
export type TipoVerificacion = 'entrada' | 'salida' | 'almuerzo_inicio' | 'almuerzo_fin';

// ----- Calendario de días no laborables -----
export interface AutorizadoDia {
  usuarioId: number;
  nombre: string;
  codigo: string;
  motivo: string | null;
}

export interface DiaCalendario {
  fecha: string; // AAAA-MM-DD
  laborable: boolean;
  origen: 'admin' | 'semanal' | 'feriado' | 'normal';
  motivo: string | null;
  feriado: string | null;
  decision: boolean | null; // lo fijado por el administrador (null = nada)
  autorizados: AutorizadoDia[];
}

export interface CalendarioRespuesta {
  hoy: string;
  zonaHoraria: string;
  diasLibres: number[];
  dias: DiaCalendario[];
}

export interface EstadoDiaHoy {
  fecha: string;
  laborable: boolean;
  motivo: string | null;
}

// ----- Aviso de privacidad -----
export interface InfoPrivacidad {
  version: number;
  exigida: boolean;
  aceptada: boolean;
  empresa: {
    nombre: string;
    ruc: string;
    domicilio: string;
    correoDatos: string;
    proveedor: string;
    paisServidor: string;
    alternativa: string;
    diasRostroTrasCese: number;
  };
  plazos: { gpsDias: number; fotosDias: number; registrosDias: number };
}
