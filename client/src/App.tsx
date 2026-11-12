import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { WorkerPage } from './pages/WorkerPage';
import { AdminPage } from './pages/AdminPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Ruta principal: Aplicación Móvil del Trabajador (PWA / Reloj Marcador) */}
        <Route path="/" element={<WorkerPage />} />
        <Route path="/trabajador" element={<WorkerPage />} />

        {/* Ruta administrativa: Consola de Supervisión & Mapa en Tiempo Real */}
        <Route path="/admin" element={<AdminPage />} />

        {/* Redirección por defecto */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
