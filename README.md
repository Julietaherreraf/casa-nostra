# Casa Nostra — agenda de reservas

Webapp estática (GitHub Pages) con Firebase Auth (Google) y Firestore.

- **Juli** (`julietaherreraf@gmail.com`) ve y edita reservas, y maneja quién tiene acceso desde el botón **Acceso**.
- **Lectores** (mails cargados en Acceso) solo pueden ver.
- **Envía autorizaciones** (tilde en Acceso): además ve los *Datos autorización* (DNI) de cada reserva y manda el mensaje a portería por WhatsApp.
- Cualquier otra cuenta ve "Todavía no tenés acceso".

## Datos autorización

Cada reserva tiene un botón **Datos autorización**. Juli pega el listado de nombres y DNI tal como llega por WhatsApp; quien envía ve el mensaje armado (DNI tapados en pantalla, completos al enviar o copiar). La firma (nombre y DNI) se carga en **Acceso**. Cuando termina la estadía, los DNI se guardan enmascarados (`••.•••.123`) la próxima vez que Juli abre la app.

La seguridad la ponen las reglas de `firestore.rules`, no la interfaz. La `apiKey` de `app.js` es pública por diseño.

## Puesta en marcha (una sola vez)

1. **Reglas:** Firebase → Firestore → pestaña *Rules* → pegar el contenido de `firestore.rules` → *Publish*.
2. **Dominio autorizado:** Firebase → Authentication → *Settings* → *Authorized domains* → *Add domain* → `julietaherreraf.github.io`.
3. **GitHub Pages:** repo → *Settings* → *Pages* → *Source: Deploy from a branch* → `main` / `/ (root)` → *Save*.
4. Abrir `https://julietaherreraf.github.io/casa-nostra/`, entrar con Google como Juli y tocar **Cargar las 5 reservas actuales**.
5. **Acceso** → agregar los Gmail de quienes tienen que ver la agenda, tildar *Envía autorizaciones* para quien manda los datos a portería y cargar la firma.

Cada vez que cambia `firestore.rules` hay que volver a pegarlo en Firebase → Firestore → *Rules* → *Publish*.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | Página |
| `app.js` | Lógica, Firebase y vistas (lista / calendario) |
| `styles.css` | Estilos, modo claro y oscuro |
| `firestore.rules` | Permisos de la base de datos |
| `manifest.webmanifest`, `icon-*.png` | Para agregarla a la pantalla de inicio |

Si cambia el mail de quien edita, hay que cambiarlo en **dos** lugares: `EDITOR` en `app.js` y `isEditor()` en `firestore.rules` (y volver a publicar las reglas).
