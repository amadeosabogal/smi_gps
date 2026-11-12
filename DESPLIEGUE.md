# Despliegue a producción — SMI GPS

Guía para publicar el sistema y hacer pruebas en producción.

## 1. Requisitos
- Node.js 20 o superior (probado con 24).
- Acceso a la base SQL Server `GPS_SMI`.
- **HTTPS obligatorio**: el navegador del celular solo permite cámara y GPS en páginas seguras.
  Usa un proxy inverso (Caddy, nginx, Cloudflare) o los certificados propios (`SSL_KEY_PATH` / `SSL_CERT_PATH`).

## 2. Configuración (`service/.env`)
Copia `service/.env.example` a `service/.env` y completa los valores. **Nunca subas este archivo a git** (ya está en `.gitignore`).

| Variable | Qué es |
|---|---|
| `NODE_ENV=production` | Activa errores genéricos, HSTS y CORS cerrado |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexión a SQL Server |
| `JWT_SECRET` | Clave para firmar sesiones (mín. 32 caracteres, aleatoria) |
| `CORS_ORIGINS` | Dominios permitidos (vacío = solo el mismo dominio, lo recomendado si el backend sirve el frontend) |
| `TRUST_PROXY=1` | Si hay un proxy inverso delante |
| `FACE_MATCH_THRESHOLD` | Umbral de coincidencia facial (0.58 por defecto; más bajo = más estricto) |
| `ALLOW_SELF_ENROL=false` | Opcional: obliga a que solo un administrador enrole rostros |
| `LOGIN_IP_MAX` | Intentos de login **fallidos** permitidos por IP cada 10 min (60 por defecto). Toda una planta suele compartir IP, así que debe ser alto; cada cuenta se protege aparte (8 fallos / 15 min) |

Generar un `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Antes del primer arranque (una sola vez)
```bash
npm install
npm run migrate-security      # amplía la columna pin y convierte los PIN a hash
```
Prueba primero sin cambiar nada: `node service/migrate-security.mjs --dry-run`.

Impide que un trabajador tenga dos turnos activos a la vez (doble toque, dos dispositivos):
```bash
npm run migrate-turnos        # primero revisa si hay duplicados; con --dry-run solo simula
```

Después **cambia todos los PIN por defecto** (el script anterior te lista quiénes los tienen):
```bash
npm run set-pin -- ADM-001 "UnaClaveLarga2026"   # administrador: mínimo 8 caracteres
npm run set-pin -- EMP-101 482916                 # trabajador: 4 a 6 dígitos
```

## 4. Compilar y arrancar
```bash
npm run build:prod     # genera client/dist
npm run start:prod     # el backend sirve la API, los WebSockets y la app web/PWA
```
La app queda en `https://tu-dominio/` (trabajadores) y `https://tu-dominio/admin` (administración).

Opciones de compilación del frontend (`client/.env`, se leen al hacer `build`):
- `VITE_GOOGLE_MAPS_API_KEY`: clave de Google Maps. **Restríngela por dominio** en Google Cloud Console.
- `VITE_ENABLE_SIMULATION=true`: muestra los botones de "Simular movimiento" (pruebas de geocerca en interiores). **Déjalo apagado en producción real**: permite que un trabajador marque estar en cualquier estación.
- `VITE_API_BASE_URL`: solo para la app móvil Capacitor (ej. `https://asistencia.tuempresa.com`).

### Rendimiento con muchos trabajadores a la vez
- Las listas del panel **no incluyen fotos**: se piden una por una al verlas (`/api/photos/...`, solo para administradores).
- El panel pide el estado en vivo cada 3 s (liviano) y los listados completos cada 30 s o, tras un grupo de marcas, en **una sola** recarga.
- El login no congela el servidor: el hash del PIN se calcula en hilos aparte.
- Entrada y salida se guardan en una transacción: si algo falla, no queda nada a medias.
- Si ves que PM2 reinicia el servidor por memoria, sube `max_memory_restart` en `ecosystem.config.cjs`.

## 5. Qué protege el sistema
- Los PIN se guardan con hash (scrypt); el login se bloquea tras varios intentos fallidos.
- Toda la API exige sesión; los trabajadores solo pueden operar sobre su propio usuario.
- El rostro se compara **en el servidor**; el navegador ya no recibe el descriptor facial de nadie.
- Para marcar entrada/salida hace falta un ticket de verificación facial de un solo uso (válido 3 min).
- Los intentos con rostro ajeno quedan en la auditoría de fraude y bloquean tras 5 fallos en 10 min.
- El parpadeo es obligatorio en el celular (prueba de vida).
- Los WebSockets exigen sesión y los eventos en vivo solo llegan a administradores.

## 6. Límites conocidos (conviene saberlos)
- **La prueba de parpadeo corre en el celular.** Un atacante técnico podría enviar al servidor un descriptor facial fabricado. El servidor valida el formato, compara con el rostro enrolado y limita los intentos, pero no puede comprobar que el descriptor provenga de una cámara real. Un video grabado de la persona parpadeando podría engañar a la cámara.
- **El GPS lo reporta el celular**, y puede falsearse con apps de ubicación falsa.
- **El primer enrolamiento** lo puede hacer quien conozca el PIN del trabajador. Para mayor control, `ALLOW_SELF_ENROL=false` y enrola desde el panel de administración.
- La contraseña de la base que estuvo en el código debe considerarse comprometida: **cámbiala en SQL Server** y actualiza `DB_PASSWORD`.
- Prefiere un usuario de SQL con permisos solo sobre `GPS_SMI` en lugar de `sa`, y no expongas el puerto de SQL Server a internet.
- `service/init-db.mjs` **borra todas las tablas**; exige `--force-destroy-all-data` a propósito.

## 7. Lista de verificación para las pruebas en producción
1. `GET https://tu-dominio/api/health` responde `{"estado":"ok"}`.
2. Ingreso en `/admin` con tu código y clave (un PIN incorrecto es rechazado).
3. Crear un trabajador de prueba desde el panel (se muestra su PIN una sola vez).
4. En el celular (HTTPS): ingresar como ese trabajador, enrolar el rostro, parpadear, marcar entrada.
5. Ver el movimiento en vivo en el panel de administración.
6. Marcar salida; probar con otra persona para ver que se bloquea y queda en la auditoría de fraude.
7. Revisar que la app se pueda instalar como PWA (ícono, pantalla completa).
