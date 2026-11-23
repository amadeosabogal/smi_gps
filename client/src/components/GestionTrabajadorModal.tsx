import React, { useState } from 'react';
import { X, Download, KeyRound, UserMinus, UserCheck, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import type { Usuario } from '../types';

interface Props {
  trabajador: Usuario;
  onClose: () => void;
  /** Recargar la lista del personal (cambió algo) */
  onCambio: () => void;
}

// Derechos del trabajador sobre sus datos: corregir, nuevo PIN, copia, baja y eliminación total
export const GestionTrabajadorModal: React.FC<Props> = ({ trabajador, onClose, onCambio }) => {
  const [nombre, setNombre] = useState(trabajador.nombre);
  const [dni, setDni] = useState(trabajador.dni || '');
  const [cargo, setCargo] = useState(trabajador.cargo || '');
  const [correo, setCorreo] = useState(trabajador.correo || '');
  const [telefono, setTelefono] = useState(trabajador.telefono || '');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [pinNuevo, setPinNuevo] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState('');
  const [eliminado, setEliminado] = useState(false);
  const de_baja = !trabajador.activo;

  const ejecutar = async (clave: string, fn: () => Promise<string | void>, recargar = true) => {
    setOcupado(clave);
    setMensaje(null);
    try {
      const texto = await fn();
      if (texto) setMensaje({ tipo: 'ok', texto });
      if (recargar) onCambio();
    } catch (e: any) {
      setMensaje({ tipo: 'error', texto: e.message || 'No se pudo completar la acción' });
    } finally {
      setOcupado(null);
    }
  };

  const guardar = (e: React.FormEvent) => {
    e.preventDefault();
    ejecutar('datos', async () => {
      await api.updateUser(trabajador.id, { nombre, cargo, correo, telefono, ...(dni.trim() && dni.trim() !== (trabajador.dni || '') ? { dni: dni.trim() } : {}) });
      return 'Datos corregidos.';
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Datos personales del trabajador">
      <div className="my-6 w-full max-w-lg border border-slate-300 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{trabajador.nombre}</h3>
            <p className="text-sm text-slate-600">
              {trabajador.codigo_empleado}
              {de_baja && <span className="ml-2 border border-red-300 bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-800">De baja</span>}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Aviso de privacidad:{' '}
              {trabajador.privacidad_aceptada_en ? `aceptado el ${new Date(trabajador.privacidad_aceptada_en).toLocaleDateString('es-PE')}` : 'pendiente de aceptar'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="text-slate-500 hover:text-slate-900">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-4">
          {mensaje && (
            <p role={mensaje.tipo === 'error' ? 'alert' : 'status'} className={`border px-3 py-2 text-sm ${mensaje.tipo === 'error' ? 'border-red-300 bg-red-50 text-red-800' : 'border-green-300 bg-green-50 text-green-900'}`}>
              {mensaje.texto}
            </p>
          )}

          {eliminado ? (
            <p className="text-sm text-slate-700">Todos los datos del trabajador fueron eliminados. Puede cerrar esta ventana.</p>
          ) : (
            <>
              <form onSubmit={guardar} className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-900">Corregir datos</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label htmlFor="g-dni" className="field-label">DNI (con él ingresa a la app)</label>
                    <input id="g-dni" className="field font-mono" value={dni} maxLength={12} placeholder="8 dígitos" onChange={(e) => setDni(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
                    {!trabajador.dni && <p className="mt-1 text-xs text-amber-700">Sin DNI el trabajador no puede ingresar.</p>}
                  </div>
                  <div>
                    <label htmlFor="g-nombre" className="field-label">Nombre</label>
                    <input id="g-nombre" className="field" value={nombre} maxLength={150} onChange={(e) => setNombre(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="g-cargo" className="field-label">Cargo</label>
                    <input id="g-cargo" className="field" value={cargo} maxLength={100} onChange={(e) => setCargo(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="g-correo" className="field-label">Correo</label>
                    <input id="g-correo" type="email" className="field" value={correo} maxLength={150} onChange={(e) => setCorreo(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="g-tel" className="field-label">Teléfono</label>
                    <input id="g-tel" className="field" value={telefono} maxLength={30} onChange={(e) => setTelefono(e.target.value)} />
                  </div>
                </div>
                <button type="submit" disabled={ocupado !== null} className="btn-primary">
                  {ocupado === 'datos' ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </form>

              <div className="space-y-2 border-t border-slate-200 pt-4">
                <h4 className="text-sm font-semibold text-slate-900">Acceso y PIN</h4>
                <button
                  type="button"
                  disabled={ocupado !== null || de_baja}
                  className="btn-secondary"
                  onClick={() => ejecutar('pin', async () => { const r = await api.resetUserPin(trabajador.id); setPinNuevo(r.pinNuevo); }, false)}
                >
                  <KeyRound className="h-4 w-4" /> Generar un PIN nuevo
                </button>
                {pinNuevo && (
                  <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    PIN nuevo: <strong className="font-mono text-base tracking-widest">{pinNuevo}</strong>. Entréguelo ahora: no se vuelve a mostrar.
                  </p>
                )}
              </div>

              <div className="space-y-2 border-t border-slate-200 pt-4">
                <h4 className="text-sm font-semibold text-slate-900">Copia de sus datos (derecho de acceso)</h4>
                <p className="text-xs text-slate-600">Archivo con sus datos, asistencias, recorrido, almuerzos y alertas. Con fotos puede pesar mucho.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={ocupado !== null} className="btn-secondary" onClick={() => ejecutar('exp', async () => { await api.downloadUserData(trabajador.id, false); return 'Descarga lista.'; }, false)}>
                    <Download className="h-4 w-4" /> {ocupado === 'exp' ? 'Preparando…' : 'Descargar sin fotos'}
                  </button>
                  <button type="button" disabled={ocupado !== null} className="btn-secondary" onClick={() => ejecutar('expf', async () => { await api.downloadUserData(trabajador.id, true); return 'Descarga lista.'; }, false)}>
                    <Download className="h-4 w-4" /> {ocupado === 'expf' ? 'Preparando…' : 'Descargar con fotos'}
                  </button>
                </div>
              </div>

              <div className="space-y-2 border-t border-slate-200 pt-4">
                <h4 className="text-sm font-semibold text-slate-900">{de_baja ? 'Cuenta dada de baja' : 'Dar de baja'}</h4>
                {de_baja ? (
                  <>
                    <p className="text-xs text-slate-600">No puede ingresar. Su rostro fue borrado: al reactivarlo deberá registrarlo de nuevo.</p>
                    <button type="button" disabled={ocupado !== null} className="btn-secondary" onClick={() => ejecutar('react', async () => { await api.reactivarUser(trabajador.id); return 'Cuenta reactivada.'; })}>
                      <UserCheck className="h-4 w-4" /> Reactivar
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-slate-600">Desactiva su cuenta (ya no puede ingresar) y borra su foto de referencia y la huella de su rostro. Su historial se conserva según los plazos.</p>
                    <button
                      type="button"
                      disabled={ocupado !== null}
                      className="btn-secondary"
                      onClick={() => {
                        if (!window.confirm(`¿Dar de baja a ${trabajador.nombre}? Se borrará su rostro y no podrá ingresar.`)) return;
                        ejecutar('baja', async () => { await api.bajaUser(trabajador.id); return 'Cuenta dada de baja y rostro borrado.'; });
                      }}
                    >
                      <UserMinus className="h-4 w-4" /> Dar de baja
                    </button>
                  </>
                )}
              </div>

              <div className="space-y-2 border border-red-300 bg-red-50 p-3">
                <h4 className="text-sm font-semibold text-red-900">Eliminar todos sus datos (irreversible)</h4>
                <p className="text-xs text-red-900">
                  Borra su usuario, asistencias, almuerzos, recorridos GPS, fotos y alertas. Úselo solo cuando el trabajador lo pida por ley y no deba
                  conservarse nada. Descargue antes una copia si hace falta.
                </p>
                <label htmlFor="g-conf" className="field-label">Escriba <strong>{trabajador.codigo_empleado}</strong> para confirmar</label>
                <input id="g-conf" className="field" value={confirmar} onChange={(e) => setConfirmar(e.target.value)} autoComplete="off" />
                <button
                  type="button"
                  disabled={ocupado !== null || confirmar !== trabajador.codigo_empleado}
                  className="inline-flex items-center gap-2 border border-red-700 bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
                  onClick={() =>
                    ejecutar('elim', async () => {
                      await api.bajaUser(trabajador.id, { eliminarDatos: true, confirmar });
                      setEliminado(true);
                      return 'Todos los datos fueron eliminados.';
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" /> {ocupado === 'elim' ? 'Eliminando…' : 'Eliminar todo'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
