# SMI GPS - Control de Asistencia y Geolocalización en Tiempo Real 📍🏢

Sistema corporativo de registro de entrada/salida y geocercas en estaciones de trabajo en tiempo real con biometría facial anti-fraude.

---

## 📁 Estructura del Proyecto

El proyecto está organizado en dos módulos independientes:

```
GPS_SMI/
├── client/                  # 💻 FRONTEND (React 19 + TypeScript + Vite + Tailwind + PWA)
│   ├── public/              # Modelos de Face-API, manifiesto e íconos PWA
│   ├── src/                 # Componentes, páginas, servicios y hooks
│   ├── index.html           # Punto de entrada HTML
│   ├── vite.config.ts       # Configuración de Vite, proxy y PWA
│   ├── package.json         # Dependencias exclusivas del frontend
│   └── tsconfig.json        # Configuración de TypeScript
│
├── service/                 # ⚙️ BACKEND (Node.js + Express + Socket.IO + SQL Server)
│   ├── server.mjs           # Servidor principal, APIs REST y WebSockets
│   ├── init-db.mjs          # Script de inicialización de tablas SQL
│   ├── migrate-*.mjs        # Scripts de migración de esquema
│   ├── package.json         # Dependencias exclusivas del backend
│   └── test-db.mjs          # Script de prueba de conexión a SQL Server
│
├── package.json             # Scripts de orquestación raíz y workspaces
└── README.md
```

---

## 🚀 Cómo Iniciar el Proyecto

Puedes iniciar los servicios desde la raíz o entrando a cada carpeta:

### Opción A: Desde la raíz del proyecto

1. **Iniciar el Backend:**
   ```bash
   npm run server
   ```
   *Corre en `http://localhost:3001`*

2. **Iniciar el Frontend (en otra terminal):**
   ```bash
   npm run dev
   ```
   *Disponible en `https://localhost:5173` y en red local*

---

### Opción B: Entrando a cada carpeta

1. **Backend:**
   ```bash
   cd service
   node server.mjs
   ```

2. **Frontend:**
   ```bash
   cd client
   npm run dev
   ```

---

## 🛠️ Comandos de Construcción

* **Compilar Frontend para producción:**
  ```bash
  npm run build
  ```
  *(Genera los archivos optimizados dentro de `client/dist`)*
