# Olimpiadas - levantamiento de respuestas

Aplicación local tipo Kahoot para gestionar una sección, lanzar preguntas, recibir respuestas de estudiantes y ver ranking inmediato con podio publicable.

## Perfiles

- Administrador: gestiona secciones, bancos de preguntas, QR, apertura/cierre de respuestas, ranking, ganadores y registro de intervención.
- Proyección: muestra código, QR, temporizador, estadísticas y resultados.
- Estudiante: ingresa por QR/código, registra nombre y RUT, responde una sola vez por pregunta y ve sus resultados cuando se publican.

## Uso rápido

1. Ejecutar `iniciar_olimpiadas.bat`.
2. Abrir `http://127.0.0.1:8788/admin` en el computador del evaluador.
3. Ingresar con la cuenta administradora: usuario `administrador`, clave `admin123`.
4. Elegir sección y banco de preguntas.
5. Crear código QR y abrir la pantalla de proyección.
6. En la pantalla de proyección ingresar con usuario `proyeccion`, clave `curso123`.
7. Mostrar el QR a estudiantes, abrir respuestas desde administrador y publicar ganadores al final.

## Instalación manual

```bash
npm install
node server.js
```

Luego abrir `http://127.0.0.1:8788/admin`.

## Archivos importantes

- `server.js`: servidor local y API.
- `public/`: frontend de administrador, proyección y estudiantes.
- `data.json`: secciones y bancos de preguntas base.
- `Formato_carga_preguntas.docx`: plantilla para cargar preguntas desde Word.
- `Formato_reporte_intervencion_diaria.docx`: plantilla del registro diario.

## Privacidad

El archivo `responses-db.json` queda fuera del repositorio porque puede contener nombres, RUT y respuestas de estudiantes.
