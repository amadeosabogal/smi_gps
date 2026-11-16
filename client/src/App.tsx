import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { WorkerPage } from './pages/WorkerPage';
import { AdminPage } from './pages/AdminPage';
import { UpdatePrompt } from './components/UpdatePrompt';
import { esAppNativa } from './services/nativeTracker';

export function App() {
  return (
    <BrowserRouter>
      {/* La app Android lleva su propia versión empaquetada: el aviso de actualización web no aplica */}
      {!esAppNativa && <UpdatePrompt />}
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
