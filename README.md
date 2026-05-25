# Olimpiadas - levantamiento de respuestas

Aplicación tipo Kahoot para gestionar una sección, lanzar preguntas, recibir respuestas de estudiantes y ver ranking inmediato con podio publicable.

## Perfiles

- Administrador: gestiona secciones, bancos de preguntas, QR, apertura/cierre de respuestas, ranking, ganadores y registro de intervención.
- Proyección: muestra código, QR, temporizador, estadísticas y resultados.
- Estudiante: ingresa por QR/código, registra nombre y RUT, responde una sola vez por pregunta y ve sus resultados cuando se publican.

## Uso rápido local

1. Ejecutar `iniciar_olimpiadas.bat`.
2. Abrir `http://127.0.0.1:8788/admin` en el computador del evaluador.
3. Ingresar con la cuenta administradora configurada para el evaluador.
4. Elegir sección y banco de preguntas.
5. Crear código QR y abrir la pantalla de proyección.
6. Mostrar el QR a estudiantes, abrir respuestas desde administrador y publicar ganadores al final.

## Instalación manual

```bash
npm install
npm start
```

Luego abrir `http://127.0.0.1:8787/admin`, o el puerto indicado por la variable `PORT`.

## Despliegue web

Esta plataforma necesita un servidor Node persistente. Para que funcione bien en web, usa una plataforma que permita proceso Node, escritura persistente o base de datos, y Python si vas a importar cuestionarios Word.

Variables recomendadas:

- `PUBLIC_BASE_URL`: URL pública del sitio, por ejemplo `https://hackathon-olimpiadas.onrender.com`. Esto permite que el QR funcione desde cualquier red.
- `PORT`: puerto entregado por la plataforma.
- `DATA_PATH`: ruta persistente para secciones y bancos de preguntas, por ejemplo `/data/data.json`.
- `RESPONSES_DB_PATH`: ruta de la base de respuestas en un disco persistente, por ejemplo `/data/responses-db.json`.
- `SESSIONS_DB_PATH`: ruta persistente para formularios, cÃ³digos QR, temporizador y estado de publicaciÃ³n, por ejemplo `/data/sessions-db.json`.
- `UPLOADS_DIR`: ruta donde se guardan los Word cargados, por defecto `public/uploads`.
- `PYTHON_BIN`: comando o ruta de Python, por ejemplo `python3`.
- `WORD_IMPORT_FALLBACK_PYTHON`: usa `1` solo si quieres activar el importador Python antiguo como respaldo.
- `ADMIN_USERNAME`: usuario administrador. Por defecto: `administrador`.
- `ADMIN_PASSWORD`: clave administradora.
- `PROJECTION_USERNAME`: usuario de proyección, solo si vuelves a proteger ese perfil.
- `PROJECTION_PASSWORD`: clave de proyección, solo si vuelves a proteger ese perfil.

Si no defines `ADMIN_PASSWORD`, el servidor genera una clave temporal al iniciar y la muestra solo en la consola/log del servidor.

Comandos de despliegue:

```bash
npm install
npm start
```

La carga de cuestionarios Word se guarda como archivo físico en el backend y luego se procesa con el importador JavaScript incluido en el servidor. En cada banco importado queda registrada la URL del archivo en `/uploads/...`. Python queda solo como respaldo opcional.

Al eliminar un banco importado desde Word, el sistema también elimina el archivo físico asociado cuando ningún otro banco lo está usando. Si el banco está en una sesión activa, el administrador debe confirmar la eliminación forzada y esa sesión se cierra.

Para habilitar la importación Word en un servidor con Python:

```bash
pip install -r requirements.txt
```

## Archivos importantes

- `server.js`: servidor local/web y API.
- `public/`: frontend de administrador, proyección y estudiantes.
- `data.json`: secciones y bancos de preguntas base.
- `responses-db.example.json`: ejemplo de la base de respuestas persistente.
- `sessions-db.json`: base local de formularios/cÃ³digos creados. No se sube al repositorio.
- `Formato_carga_preguntas.docx`: plantilla para cargar preguntas desde Word.
- `Formato_reporte_intervencion_diaria.docx`: plantilla del registro diario.

## Privacidad

El archivo real `responses-db.json` queda fuera del repositorio porque puede contener nombres, RUT y respuestas de estudiantes. Al ejecutar la plataforma, el sistema lo crea automáticamente cuando recibe respuestas. Si necesitas partir con una estructura visible, copia `responses-db.example.json` como `responses-db.json`.
