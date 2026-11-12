export interface Usuario {
  id: number;
  codigo_empleado: string;
  nombre: string;
  correo: string;
  rol: 'administrador' | 'supervisor' | 'trabajador';
  cargo: string;
  telefono?: string;
  activo: boolean;
  foto_ref_bytes?: number; // tamaño de la foto de referencia (0 = sin foto); la imagen se pide aparte
  facial_enrolado?: boolean;
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
}
