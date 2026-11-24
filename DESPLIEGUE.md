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
| `GPS_MAX_ACCURACY_CHECKIN_M`, `GPS_MAX_ACCURACY_PING_M` | Precisión GPS exigida en metros para marcar entrada (50) y para los puntos durante el turno (100). Una ubicación aproximada como ±2000 m se rechaza |
| `BUSINESS_TZ` | Zona horaria que decide qué día es "hoy" para el calendario de días no laborables (`America/Lima` por defecto) |
| `RETENCION_UBICACIONES_DIAS` | Opcional. Días que se conservan los **puntos GPS del recorrido** (mínimo 7). Vacío = no borrar nunca. No afecta a la asistencia ni a las fotos |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Claves de las **notificaciones push** (alertas al celular). Se generan con `npm run vapid`. La privada es un secreto; usa una pareja distinta en producción |

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

Índices para que el historial y la retención sigan rápidos con muchos registros:
```bash
npm run migrate-historial     # con --dry-run solo muestra qué haría
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
- **Puntos GPS:** el celular envía uno cada 15 s (o antes, mínimo 5 s, si el trabajador se movió más de 25 m), y el servidor descarta los casi idénticos (menos de 5 s y 10 m). Sin esto el GPS puede avisar cada segundo (~30 GB/año con 30 trabajadores).
- **Historial del panel:** filtro por fechas (últimos 7 días por defecto), búsqueda en el servidor y paginación de 50 en 50; **Exportar CSV** descarga todo el rango filtrado.
- **Retención de puntos GPS (opcional):** `npm run purge-historial -- --days=90` solo **cuenta**; con `--apply` borra. O define `RETENCION_UBICACIONES_DIAS=90` y el servidor lo hace solo cada 24 h. Es irreversible: haz un respaldo antes.
- Entrada y salida se guardan en una transacción: si algo falla, no queda nada a medias.
- Si ves que PM2 reinicia el servidor por memoria, sube `max_memory_restart` en `ecosystem.config.cjs`.

### Alertas al celular del trabajador (notificaciones push)
El administrador/supervisor puede enviar una alerta a un trabajador en turno (botón **🔔 Enviar alerta** en *Personal en Turno*, destacado en ámbar si está fuera de zona). Le llega al celular como una notificación del sistema, **aunque tenga la pantalla apagada y la app cerrada**.

Puesta en marcha (una vez):
```bash
npm run vapid                 # imprime 3 líneas VAPID_*: pégalas en service/.env y pon un correo real en VAPID_SUBJECT
npm run migrate-push          # crea SuscripcionesPush y AlertasEnviadas (con --dry-run solo simula)
pm2 restart smi-gps
```
En nginx, el archivo que importa el service worker tampoco debe quedar en caché (junto al bloque de `/sw.js`):
```nginx
    location = /push-sw.js {
        add_header Cache-Control "no-cache";
    }
```

Cómo funciona y qué esperar:
- Cada trabajador debe **tocar "Activar alertas"** una vez en su celular y aceptar el permiso. En el panel se ve quién las tiene activadas (🔔) y quién no (🔕).
- El mensaje viaja **cifrado** a Google/Apple/Mozilla y de ahí al celular. Cada alerta queda en la tabla `AlertasEnviadas` (quién la envió, a quién, cuándo y si fue leída).
- Si el trabajador tiene la app abierta, ve además un aviso a pantalla completa con vibración. Al tocar la notificación o "Entendido" la alerta queda **leída** y el panel lo avisa en vivo.
- **Android (Chrome):** funciona con la app instalada o en el navegador. **iPhone/iPad:** solo funciona si la app está **instalada en la pantalla de inicio** (iOS 16.4 o superior).
- Al cerrar sesión, el celular deja de recibir las alertas de ese trabajador (así no llegan a otra persona si comparten teléfono).

Límites que conviene saber:
- Las notificaciones push web son *casi* tan fiables como las de WhatsApp, pero no iguales: el servidor confirma que **entregó** el mensaje al servicio de Google/Apple, no que el celular lo haya mostrado. La confirmación real es la lectura (cuando el trabajador la toca).
- Algunos fabricantes de Android (Xiaomi, Huawei, Oppo…) y el "ahorro de batería" pueden retrasar o bloquear notificaciones de apps en segundo plano. Se arregla en Ajustes → Batería → permitir sin restricciones, o dejando la app instalada.
- Si el trabajador desactiva las notificaciones o desinstala la app, el servidor lo detecta en el siguiente envío y elimina esa suscripción.
- Para entrega garantizada tipo WhatsApp (alta prioridad nativa) haría falta una app nativa con Firebase; el proyecto ya incluye Capacitor por si se quiere dar ese paso.

### Precisión y continuidad del GPS
- **Entrada:** exige una ubicación fresca y precisa (±50 m o menos por defecto). La app espera hasta 15 s a que el GPS mejore y, si no llega a esa precisión, no deja marcar y explica cómo mejorarla. El servidor lo verifica aparte, así que no se puede saltar. Si el rechazo es por el GPS, el ticket facial no se consume.
- **Durante el turno:** los puntos con precisión peor a ±100 m se descartan (no se guardan) y el trabajador ve el aviso. En el panel se ve la antigüedad de la última señal ("Sin señal GPS desde hace N min") y los trabajadores con GPS impreciso.
- **Límite de las aplicaciones web (PWA):** el navegador **deja de entregar el GPS cuando la pantalla se apaga o la app pasa a segundo plano**. La app mantiene la pantalla encendida durante el turno y avisa al trabajador, pero si bloquea el teléfono o cambia de aplicación el seguimiento se detiene (en iPhone es más estricto). Para seguimiento continuo en un vehículo hace falta una app nativa con servicio en segundo plano (el proyecto ya incluye Capacitor).

### App Android (rastreo con la pantalla apagada)
La app nativa es la misma interfaz dentro de Capacitor, más un **servicio en primer plano** (`client/android/.../TrackerService.java`) que captura el GPS y lo envía **por sí mismo** al servidor, sin depender del navegador. Sigue funcionando con la pantalla apagada, con la app cerrada y en modo de ahorro (Doze); si no hay internet, guarda los puntos en el teléfono y los envía después con su hora real; si el celular se reinicia en medio del turno, lo retoma.

Cómo se conecta con el servidor:
- Al marcar entrada la app pide `POST /api/location/track-token` (token que solo sirve para `POST /api/location/batch`, atado a ese turno, caduca en `TRACK_TOKEN_HOURS`=18 h) y se lo entrega al servicio.
- El servicio envía lotes a `/api/location/batch`. Si el servidor responde `SIN_TURNO` (salida marcada), el servicio se detiene solo.
- En `service/.env` añade `https://localhost` a `CORS_ORIGINS` (origen del WebView de la app), por ejemplo `CORS_ORIGINS=https://asistencia.smi-peru.com,https://localhost`.

Compilar el APK (requiere Android Studio; usa su JDK 21):
```bash
cd client
VITE_API_BASE_URL=https://asistencia.smi-peru.com npx vite build   # la app necesita la dirección absoluta del servidor
npx cap sync android
cd android
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug   # APK en app/build/outputs/apk/debug/
```
Cada trabajador debe conceder en el celular: ubicación precisa, **"Permitir todo el tiempo"**, notificaciones y batería "sin restricciones" (la app los guía paso a paso antes de la primera entrada). Xiaomi/Redmi/POCO además necesitan "Inicio automático".

**Alertas del supervisor en la app Android:** viajan en la respuesta de cada envío de ubicación (cada ~15 s). El servicio las muestra como notificación del sistema (suena y vibra, también con la pantalla apagada). Al tocarla, la app abre la alerta y la marca como leída. Una alerta sin leer se entrega durante 15 minutos; si el celular no tiene internet en ese momento, la recibe al reconectar. No usa Firebase.

**APK firmado (versión de entrega):**
- La llave de firma está en `C:\Users\LENOVO\SMI-GPS-llave\` (`smi-gps.jks` + `claves.txt` con las contraseñas). **Respáldala en al menos dos lugares fuera de la computadora** (USB, gestor de contraseñas). Si se pierde, no se podrá actualizar la app: habría que desinstalarla y reinstalarla en todos los celulares. Nunca se sube a git (`client/android/.gitignore`).
- `client/android/keystore.properties` (también fuera de git) le dice a Gradle dónde está la llave. En otra computadora hay que copiar la carpeta de la llave y crear ese archivo.
- Compilar: `VITE_API_BASE_URL=https://asistencia.smi-peru.com npx vite build`, `npx cap sync android`, y en `client/android`: `./gradlew assembleRelease`. El APK queda en `client/android/app/build/outputs/apk/release/app-release.apk`.
- Para publicar una versión nueva, sube `versionCode` (y `versionName`) en `client/android/app/build.gradle`: Android no instala encima una versión con el mismo `versionCode`.
- La versión de entrega solo admite HTTPS; la de depuración también HTTP (pruebas locales).

**Aviso de nueva versión dentro de la app:** al abrirla (y al volver a ella), la app consulta `GET /api/app/version`, que lee el archivo `version.json` junto al APK. Si el `versionCode` publicado es mayor que el instalado, muestra un aviso con el botón **Descargar** (abre el APK en el navegador) y **Ahora no** (no vuelve a avisar de esa versión). Para publicar una versión nueva:
1. En `client/android/app/build.gradle` sube `versionCode` (entero, siempre mayor) y `versionName`.
2. Compila el APK firmado (ver arriba) y súbelo, **reemplazando** `/var/www/smi_descargas/smi-gps.apk`.
3. Edita (o crea) `/var/www/smi_descargas/version.json` **después** de subir el APK:
```json
{
  "versionCode": 2,
  "versionName": "1.0.1",
  "minVersionCode": 1,
  "url": "https://asistencia.smi-peru.com/descargas/smi-gps.apk",
  "notas": "Qué cambia en esta versión (máx. 200 caracteres)"
}
```
`minVersionCode` es la versión mínima aceptable: quien tenga una menor ve el aviso en rojo y **no puede cerrarlo** (no bloquea la app ni detiene el rastreo). Usa `0` o `1` si no quieres forzar a nadie. No hace falta reiniciar el servidor (se relee cada 30 s). La ruta del archivo se puede cambiar con `ANDROID_VERSION_FILE` en `service/.env`.
El aviso existe solo desde la versión 1.0.1 de la app: quien tenga la 1.0.0 debe instalar la 1.0.1 una vez a mano.

### Un turno, un dispositivo
Cada instalación de la app (o navegador) genera un identificador y lo envía en la cabecera `X-Device-Id`. Al marcar la entrada, el turno queda **atado a ese dispositivo** (`RegistroAsistencia.dispositivo_id`): solo él puede enviar la ubicación del turno. Si el mismo usuario abre la app en otro teléfono, ese teléfono muestra "Su turno está activo en otro dispositivo", **no registra ubicación** y su servicio se detiene; el servidor responde `409/403 OTRO_DISPOSITIVO`. Así dos celulares con el mismo usuario no mezclan sus puntos y no se puede dejar un teléfono quieto mientras el trabajador se mueve con otro.

Puesta en marcha (una vez): `npm run migrate-dispositivo` (añade la columna; con `--dry-run` solo muestra qué haría) y `pm2 restart smi-gps`. Sin la columna todo funciona como antes y el servidor avisa en el arranque.

Qué esperar:
- Los turnos que ya estaban activos al migrar, y los iniciados con versiones anteriores de la app (sin identificador), **no quedan atados**: cualquier dispositivo puede enviar ubicación hasta que termine ese turno.
- La app instalada (APK) y la web (PWA) cuentan como dispositivos distintos, aunque estén en el mismo teléfono.
- Si el trabajador borra los datos de la app o la reinstala a mitad de turno, el teléfono pasa a ser "otro dispositivo": debe registrar la salida y volver a marcar la entrada. La salida se puede registrar desde cualquier dispositivo (con verificación facial), por ejemplo si perdió el teléfono donde empezó el turno.

### Prueba de vida con retos aleatorios (anti-video)
El parpadeo fijo se podía esquivar con un video grabado frente a la cámara. Ahora, antes de capturar el rostro, la app pide una **secuencia distinta cada vez** de 3 movimientos tomados al azar entre: girar la cabeza a la izquierda, girar a la derecha, sonreír, abrir la boca y parpadear dos veces (60 secuencias posibles). Solo cuenta lo que ocurre **después** de pedirlo y con el rostro antes en reposo, con 4,5 s para cada movimiento. Al final se pide mirar de frente y quieto, y esa imagen es la que se compara con el rostro registrado. Además se compara la cara del inicio con la del final de la prueba (si cambia la persona o la foto, se rechaza).
- **Intentos fallidos:** desde el 2.º fallo seguido se guarda en **Alertas de fraude** ("Falla en la prueba de vida") con la foto del intento (así se ve un video o una pantalla frente a la cámara); al 3.º se bloquea 2 minutos. Los intentos se cuentan en el celular por 10 minutos.
- **Límite honesto:** frena el video grabado y el cambio de rostro, pero un atacante que reproduzca a mano clips cortos de cada movimiento según lo que pida la pantalla todavía podría intentarlo. Las capas posibles son un detector de pantallas con IA y comparar el rostro en el servidor.
- **Cómo comprobar el sentido del giro:** abre la web en el celular con `?debug` al final de la dirección (por ejemplo `https://asistencia.smi-peru.com/?debug`) y mira la línea de "giro" bajo la cámara: de frente marca ≈ 0.50 y al girar hacia **su izquierda** debe **subir** (≈ 0.65 o más). Si en un teléfono ocurre lo contrario, cambia `INVERTIR_GIRO` a `true` en `client/src/services/eyeBlink.ts`. La app instalada (APK) usa exactamente el mismo código.

### Almuerzo dentro del turno (app 1.0.3 o posterior y web)
Durante un turno activo el trabajador toca **Iniciar almuerzo** y, al volver, **Terminar almuerzo**; ambos momentos exigen verificación facial con prueba de vida y guardan foto y similitud. El **GPS NO se detiene**: sigue registrándose igual (en la web y en el servicio de Android). Las horas del turno **no se descuentan** (solo se registra el almuerzo).
- **Panel:** la tarjeta del trabajador muestra "En almuerzo" (turquesa; no cuenta como "fuera de zona"), cuántos minutos lleva de los permitidos y se pone en rojo si se pasa; hay una tarjeta de resumen "En almuerzo". El historial tiene la columna "Almuerzo" (inicio–fin y minutos) y el CSV suma sus columnas. El visor de recorrido dibuja en turquesa los puntos del almuerzo y muestra las dos fotos.
- **Reglas:** `ALMUERZO_MINUTOS=60` (tiempo permitido) y `ALMUERZOS_POR_TURNO=1` en `service/.env`. Si el trabajador marca salida (o el administrador fuerza la salida) con el almuerzo abierto, se cierra solo. Solo se puede iniciar desde el dispositivo que marcó la entrada.
- **Puesta en marcha (una vez):** `npm run migrate-almuerzo` (crea la tabla `AlmuerzosTurno`; con `--dry-run` solo simula) y `pm2 restart smi-gps`. Sin la tabla el botón no aparece y el servidor lo avisa en el arranque.

### Días no laborables / feriados (calendario)
En un día no laborable **toda la aplicación queda bloqueada** para los trabajadores: no pueden ingresar con su PIN ni marcar asistencia. El bloqueo lo hace el **servidor** (no solo la pantalla), así que también vale para sesiones ya abiertas y para versiones viejas de la app.
- **Qué es "no laborable":** se decide por este orden → 1) lo que el administrador fijó para esa fecha (habilitar o bloquear) · 2) los **días libres fijos de la semana** (por ejemplo, domingos) · 3) los **feriados de Perú precargados** · 4) si nada aplica, día laborable. Por defecto **no hay días libres fijos** (configúralos en la pestaña *Calendario*), pero los feriados precargados **sí bloquean** hasta que el administrador los habilite.
- **Pestaña "Calendario" del panel (solo administrador escribe; el supervisor mira):** calendario por mes; al tocar un día se puede *Habilitar la app este día*, *Bloquear la app este día*, *Quitar mi decisión* y **autorizar a trabajadores concretos** (por trabajador y por fecha) aunque el día esté bloqueado. No se pueden cambiar días que ya pasaron.
- **Intentos:** si un trabajador pone su PIN correcto o usa una sesión abierta en un día bloqueado, se rechaza (403 `DIA_NO_LABORABLE`) y **queda anotado en "Alertas de fraude"** como "Intento en día no laborable" (una anotación cada 10 minutos por trabajador, sin foto). En el celular ve una pantalla con el motivo; la pantalla de ingreso avisa de antemano.
- **Quien ya tiene un turno abierto** puede seguir y terminarlo (por ejemplo, un turno nocturno que cruza la medianoche hacia un feriado); el rastreo GPS de ese turno no se corta.
- **Zona horaria:** "hoy" se decide con `BUSINESS_TZ` (por defecto `America/Lima`), no con la hora de la VPS.
- **Los feriados son una SUGERENCIA.** Están en `service/feriados-peru.mjs` (fijos + Jueves/Viernes Santo calculados): Año Nuevo, Día del Trabajo, 7 jun, San Pedro y San Pablo, 23 jul, Fiestas Patrias (28-29 jul), 6 ago, Santa Rosa de Lima, 8 oct, Todos los Santos, 8 y 9 dic, Navidad. **Verifícalos con el decreto oficial (El Peruano)** cada año: el Gobierno puede declarar días no laborables adicionales o mover alguno. Si falta uno, bloquéalo desde el calendario; si uno sobra o ese día se trabaja, usa *Habilitar la app*.
- **Puesta en marcha (una vez):** `npm run migrate-calendario` (crea `CalendarioDias`, `CalendarioExcepciones` y `CalendarioConfig`; con `--dry-run` solo simula) y `pm2 restart smi-gps`. **Sin las tablas el bloqueo NO funciona** (nadie queda bloqueado) y el servidor lo avisa en el arranque.
- **Para ver la pantalla de bloqueo en el APK** hace falta la app 1.0.4; con una versión anterior el servidor igual rechaza el ingreso y el trabajador ve el mensaje del servidor en una alerta.

### Batería del teléfono (app Android 1.0.2 o posterior)
Con cada punto GPS la app lee el porcentaje de batería y si el teléfono está conectado al cargador (lo entrega el sistema sin permisos ni gasto extra) y lo envía junto a la ubicación. Se ve en:
- **Tarjeta de cada trabajador** (Personal en Turno): "62 %", en ámbar por debajo de 30 %, en rojo por debajo de 15 %, y en verde con "· cargando". Si además está "Sin señal GPS" y su última batería fue de 10 % o menos, el panel avisa que probablemente el teléfono se apagó.
- **Visor de recorrido:** curva de batería del turno (franja verde = cargador conectado) y consumo medio por hora sin contar los tramos con cargador (solo si hubo al menos 30 min sin cargador).

Puesta en marcha (una vez): `npm run migrate-bateria` (añade `bateria` y `cargando` a `HistorialUbicaciones` y `UbicacionesEnVivo`; son columnas NULL, se crean al instante; con `--dry-run` solo muestra qué haría) y `pm2 restart smi-gps`. Sin las columnas todo funciona como antes y el servidor lo avisa en el arranque. Las versiones anteriores de la app no envían batería: esos turnos muestran "Sin datos de batería". Los puntos guardados sin internet conservan la batería que tenían al capturarse. La versión web (PWA) no envía batería.

### Ubicación apagada o sin señal durante el turno
Tres medidas, todas con alerta en **Alertas de fraude** (y aviso en pantalla al administrador conectado). **No necesitan migración**: reutilizan la tabla de alertas existente.
- **Falta de señal (servidor, sirve con cualquier versión de la app y con la web):** cada minuto el servidor busca trabajadores en turno que llevan más de `SIN_SENAL_ALERTA_MIN` minutos (por defecto 5, mínimo 2, `0` = desactivado) sin enviar ubicación y crea una alerta **"Sin señal GPS en turno"** con la hora desde la que no hay datos. Una sola alerta por interrupción. Causas posibles: sin internet, app cerrada, celular apagado o ubicación apagada sin conexión.
- **Ubicación apagada (app Android 1.0.7 o posterior):** el servicio detecta al instante que el trabajador apaga la ubicación del celular y registra **"Apagó la ubicación (GPS)"** y, al volver a encenderla, **"Reactivó la ubicación (GPS)"** con cuánto tiempo estuvo apagada. Si en ese momento no hay internet, el aviso se guarda en el celular y se envía al volver la conexión con su hora real. Cuando el celular ya avisó que apagó la ubicación, no se repite la alerta de falta de señal.
- **Presión sobre el trabajador (app 1.0.7):** notificación fuerte que no se quita deslizando y lleva a los ajustes de ubicación (se repite cada 2 min mientras siga apagada), y con la app abierta una pantalla que se bloquea hasta que la reactive.
- **Límites:** Android no permite impedir que se apague la ubicación (solo con gestión de dispositivos de empresa); se detecta y deja evidencia. Si el celular no tiene internet ni ubicación a la vez, el administrador ve la alerta de falta de señal pero no sabe dónde estuvo.
- **Puesta en marcha:** `git pull`, `cd client && npm run build`, `pm2 restart smi-gps`; opcional `SIN_SENAL_ALERTA_MIN` en `service/.env`. Subir el APK 1.0.7 y poner `versionCode 8` / `"1.0.7"` en `version.json`.

### Proyectos (agrupan las estaciones)
En la pestaña **Estaciones** el administrador crea **proyectos** (por ejemplo "Metro de Lima") y asigna cada estación a uno. Las estaciones se muestran agrupadas por proyecto (grupos plegables, con filtro), el selector **Proyecto** aparece al crear o editar una estación (también al registrarla desde el mapa) y el **historial de asistencia** se puede filtrar por proyecto (el CSV incluye la columna Proyecto). Un proyecto con estaciones no se puede eliminar hasta moverlas o eliminarlas. Los supervisores ven los proyectos pero no los modifican.
- **Necesita migración (una vez por instalación, cada una con su propia base de datos):** `npm run migrate-proyectos` (o `node service/migrate-proyectos.mjs --dry-run` para ver qué haría) y luego reiniciar el servidor. Crea la tabla `Proyectos` y la columna opcional `EstacionesTrabajo.proyecto_id`; las estaciones existentes quedan "Sin proyecto". Sin la migración el panel funciona como antes y no muestra proyectos.
- **Puesta en marcha:** `git pull`, `npm run migrate-proyectos`, `cd client && npm run build`, `pm2 restart <proceso>`. En la demo, hacerlo en su carpeta (`GPS_DEMO`, `demo-gps`).

### Salida forzada por un administrador
En **Personal en Turno** (y en el historial, en los turnos activos) el administrador tiene el botón **Forzar salida**: cierra el turno **sin verificación facial ni foto**, con la hora actual y la última ubicación conocida del trabajador. Pide un motivo obligatorio (3 a 200 caracteres) que queda en `RegistroAsistencia.notas` como `SALIDA FORZADA por <código> <nombre>: <motivo>`; el historial la marca con la etiqueta "Forzada". Solo el rol `administrador` puede hacerlo (no los supervisores) y no se puede deshacer. Si el trabajador tiene la app abierta se entera al instante; la app Android además muestra una notificación y detiene su servicio de GPS en el siguiente envío (hasta ~15 s).

### Recorrido de un turno (panel de administración)
En **Historial de asistencia** (botón "Ver recorrido" de cada turno) y en **Personal en Turno** (turnos activos) se abre un visor con el recorrido sobre el mapa: tramos verdes dentro de una estación y naranjas fuera de zona, huecos de señal punteados (más de 90 s sin ubicación), distancia, tiempo dentro/fuera y reproducción del recorrido. Un turno activo se actualiza solo cada 15 s. Lee los puntos de `HistorialUbicaciones`, por lo que **desaparecen del visor cuando la retención los borra**. Antes de usarlo en producción ejecuta una vez `npm run migrate-historial` (crea el índice `IX_HistorialUbicaciones_asistencia`; con muchos puntos tarda un poco).

Pendiente para producción: subir el servidor con los endpoints nuevos (`/api/location/batch` y `/api/location/track-token`) y publicar el APK en una ruta del dominio.

### Marca propia de una instalación (demostración o cliente nuevo)
Cada instalación puede mostrar **su propio nombre** en lugar del logo de SMI. Sin configurar nada, todo sigue como siempre (logo y nombre de SMI).
- **Web:** en `client/.env` pon `VITE_BRAND_NAME=Nombre de la marca` y compila (`npm run build:prod`). El nombre se muestra como texto en lugar del logo (ingreso, encabezados, pie), en el título de la pestaña, en el nombre de la app instalada y en las marcas de agua de las fotos.
- **Servidor:** en `service/.env` pon `BRAND_NAME=Nombre de la marca` (sale en las alertas al celular) y reinicia con `pm2 restart`.
- Quedan sin cambiar los **íconos** (favicon y el ícono de la app instalada), que siguen siendo los de SMI hasta que se agreguen los del cliente en `client/public`.
- El **APK Android** lleva su nombre y su dirección fijos al compilarse: cada cliente necesita su propio APK.

### Segunda instalación en el mismo servidor (demostración)
Cada instalación va en su propia carpeta (`/var/www/<nombre>`), con su propio `.env`, **su propia base de datos** y un usuario de base de datos que solo accede a ella, su propio puerto y proceso de PM2, y su dirección en nginx con su certificado. Nunca se comparte la base ni las claves con otra instalación. Ejemplo hecho: `demo.woditek.com` -> carpeta `smi_gps_demo`, base `GPS_DEMO`, puerto 3011, proceso `demo-gps`.
- Al pedir el certificado con `certbot --nginx`, si hay un bloque comodín (`*.dominio`) `certbot` puede instalar el certificado en ese bloque. El bloque de la instalación debe tener **su propio** `listen 443 ssl` con su certificado.
- Para crear la base con datos de ejemplo se usa `node service/init-db.mjs --force-destroy-all-data` (**borra todo** lo que haya en la base del `.env`: comprobar siempre `DB_NAME`) y luego todas las migraciones en orden: `face-recognition photos security turnos historial dispositivo bateria almuerzo calendario push privacidad dni`.

### Ingreso del trabajador con DNI y contraseña
El trabajador ya no busca su nombre en una lista: escribe su **DNI** y su **contraseña** (el mismo PIN de 4 a 6 dígitos de siempre). Así la pantalla de ingreso no muestra ningún nombre.
- **Puesta en marcha (una vez):** `npm run migrate-dni` (añade `Usuarios.dni`, único; con `--dry-run` solo simula) y `pm2 restart smi-gps`.
- **El código del trabajador pasa a ser su DNI** (por ejemplo, `EMP-106` -> `74027616`). Los administradores y supervisores conservan su código (`ADM-001`). El historial no se pierde: está ligado al trabajador, no a su código.
- **Cargar los DNI de los trabajadores que ya existen, con un archivo** (`service/cargar-dnis.mjs`):
  1. `node service/cargar-dnis.mjs --listar` crea `dnis.csv` con los trabajadores actuales (columnas `codigo_actual,nombre,dni`, con `dni` vacío).
  2. Edita `dnis.csv` (por ejemplo con `nano`) y escribe el DNI de cada uno en la tercera columna.
  3. `node service/cargar-dnis.mjs` **simula**: valida (formato, repetidos, códigos que no existen) y muestra qué cambiaría; no toca nada.
  4. `node service/cargar-dnis.mjs --apply` aplica los cambios en una sola transacción. Luego `pm2 restart smi-gps`.
  5. **Borra `dnis.csv`** al terminar (contiene datos personales). Ya está en `.gitignore` para que no se suba a git.
- **Dar de alta varios trabajadores nuevos con un archivo** (`service/agregar-trabajadores.mjs`): crea un archivo con una línea por persona (`DNI`, tabulador o espacio, `nombre completo`), ejecuta `node service/agregar-trabajadores.mjs --archivo=nuevos.txt` (**simula**: no crea nada, avisa de DNI repetidos o de alguien que ya existe con ese nombre) y luego con `--apply`. Al aplicar muestra la **contraseña (PIN) de cada uno una sola vez**: entrégasela. Borra el archivo después (tiene datos personales).
- **Trabajadores nuevos:** el panel pide solo el DNI (obligatorio; 8 dígitos, o 8 a 12 letras y números para carnet de extranjería o pasaporte) y el código se asigna solo. No puede repetirse. Para corregir el DNI de alguien: *Personal y biometría* → **Datos** → DNI (el código cambia con él).
- Las tarjetas sin DNI muestran "Sin DNI: no puede ingresar".
- **Transición sin cortar a nadie:** mientras `LOGIN_SOLO_DNI=false` (valor por defecto), las apps anteriores siguen ingresando por nombre y la lista pública de nombres sigue disponible. La app nueva (1.0.6) y la web ya piden el DNI.
- **Cuando todos tengan la app 1.0.6 y su DNI cargado**, pon `LOGIN_SOLO_DNI=true` y reinicia: se apaga el ingreso antiguo por nombre y la lista pública de nombres queda vacía (ya no se publica ningún nombre).
- El DNI es un dato personal más: figura en el aviso de privacidad y en la copia de datos del trabajador.
- Para quitar a un trabajador (por ejemplo, de prueba): *Personal y biometría* → **Datos** → *Eliminar todos sus datos* (pide escribir su código de empleado). Es irreversible.

### Protección de datos personales: plazos, aviso en la app y derechos del trabajador
Complementa el aviso de privacidad y la guía para la empresa (documentos aparte). Todo se activa con una migración y variables en `service/.env`.

**1. Borrado automático por plazos** (`service/retencion.mjs`; el servidor lo ejecuta solo cada 24 h)
- `RETENCION_FOTOS_DIAS=N` borra las **fotos** de verificación (entrada, salida, almuerzo y alertas de fraude) de más de N días; la asistencia (horas) se conserva.
- `RETENCION_REGISTROS_DIAS=N` borra las **asistencias terminadas** (con sus almuerzos y recorridos GPS), las alertas de fraude y los avisos de más de N días.
- Los puntos GPS siguen con `RETENCION_UBICACIONES_DIAS`. Mínimo 30 días en los dos nuevos (7 en GPS); vacío = no borrar nunca. Nunca se tocan turnos activos.
- A pedido: `npm run purgar-vencidos -- --fotos=365 --registros=1095` **solo cuenta**; con `--apply` borra. Es irreversible: haz un respaldo antes.
- Los plazos que configures deben ser los mismos que figuran en el aviso que se entrega al trabajador.

**2. Aviso de privacidad dentro de la app** (app Android 1.0.5 o posterior y web)
- Una vez: `npm run migrate-privacidad` (tabla `AceptacionesPrivacidad`; con `--dry-run` solo simula) y `pm2 restart smi-gps`.
- Completa en `service/.env` los datos de la empresa que ve el trabajador: `EMPRESA_NOMBRE`, `EMPRESA_RUC`, `EMPRESA_DOMICILIO`, `EMPRESA_CORREO_DATOS`, `EMPRESA_PROVEEDOR`, `EMPRESA_PAIS_SERVIDOR`, `EMPRESA_ALTERNATIVA_SIN_AUTORIZACION` y `EMPRESA_DIAS_ROSTRO_TRAS_CESE`. Los plazos que muestra salen de las variables `RETENCION_*`.
- `EXIGIR_ACEPTACION_PRIVACIDAD=true` hace obligatorio el aviso: el trabajador debe marcar las tres autorizaciones (rostro, ubicación, datos) antes de usar la app. Queda guardado cuándo, qué versión y desde qué dispositivo. Quien ya tiene un turno abierto puede terminarlo. **Actívalo cuando todos tengan la app 1.0.5**: con una versión anterior la app no muestra el aviso y el servidor rechaza sus peticiones con un mensaje.
- Si cambias el texto del aviso, sube `PRIVACIDAD_VERSION` (todos deberán aceptar de nuevo). La pestaña *Personal y biometría* muestra quién aceptó y quién está pendiente.

**3. Derechos del trabajador desde el panel** (pestaña *Personal y biometría* → botón **Datos**; solo administradores)
- **Corregir datos** (rectificación): nombre, cargo, correo y teléfono.
- **Generar un PIN nuevo**: aleatorio, se muestra una sola vez (por ejemplo, si perdió el celular).
- **Copia de sus datos** (acceso): archivo JSON con sus datos, asistencias, almuerzos, recorrido GPS, alertas y aceptaciones. "Con fotos" puede pesar mucho. No incluye el PIN ni la huella del rostro.
- **Dar de baja**: desactiva la cuenta (su sesión deja de servir de inmediato), borra su foto de referencia, la huella del rostro y sus suscripciones de notificaciones. Se niega si tiene un turno activo (fuerza antes la salida). Se puede **Reactivar**; deberá registrar su rostro de nuevo.
- **Eliminar todos sus datos** (cancelación): borra su usuario, asistencias, almuerzos, recorridos, alertas y fotos. **Irreversible**: pide escribir su código de empleado. Descarga antes una copia si hace falta.
- Cada una de estas acciones queda en el registro del servidor (`pm2 logs smi-gps`, líneas `[DATOS]`).

### Limpiar los datos de prueba antes de producción
`npm run limpiar-pruebas` borra **todo el historial** (asistencias y sus fotos, recorridos GPS, ubicaciones en vivo, almuerzos, alertas enviadas y alertas de fraude) y reinicia los contadores. **Conserva** usuarios (con su rostro y PIN), estaciones, calendario y suscripciones push.
1. Sin opciones solo **muestra** qué borraría: `npm run limpiar-pruebas`.
2. Para borrar: `npm run limpiar-pruebas -- --confirmar --respaldo "RUTA.bak"`. El respaldo (`BACKUP DATABASE`) se guarda en el equipo donde corre SQL Server; sin `--respaldo` lo borrado no se puede recuperar.
3. Se niega a borrar si hay turnos activos: antes deben marcar salida (o forzarla desde el panel).
4. Después: `pm2 restart smi-gps`.

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
