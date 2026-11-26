import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { WorkerPage } from './pages/WorkerPage';
// La consola de administración (mapas, recorrido, gráficos) pesa mucho y los trabajadores no la usan: se descarga solo en /admin
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
import { UpdatePrompt } from './components/UpdatePrompt';
import { esAppNativa } from './services/nativeTracker';
import { AppUpdateNotice } from './components/AppUpdateNotice';

export function App() {
  return (
    <BrowserRouter>
      {/* La app instalada lleva su propia versión empaquetada: el aviso de actualización web no aplica */}
      {!esAppNativa && <UpdatePrompt />}
      {/* En la app instalada el aviso equivalente consulta la última versión publicada (APK o tienda de Apple) */}
      {esAppNativa && <AppUpdateNotice />}
      <Routes>
        {/* Ruta principal: Aplicación Móvil del Trabajador (PWA / Reloj Marcador) */}
        <Route path="/" element={<WorkerPage />} />
        <Route path="/trabajador" element={<WorkerPage />} />

        {/* Ruta administrativa: Consola de Supervisión & Mapa en Tiempo Real */}
        <Route
          path="/admin"
          element={
            <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-600">Cargando…</div>}>
              <AdminPage />
            </Suspense>
          }
        />

        {/* Redirección por defecto */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
