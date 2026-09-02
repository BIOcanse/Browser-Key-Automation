# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Español | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation convierte el navegador Chromium que ya usas en una superficie de automatización delimitada por Key para Agents y programas de confianza. Tras instalar la extensión una vez y crear una Key, un cliente autorizado puede moverse entre tus pestañas ya autenticadas sin iniciar otro navegador de automatización.

La ruta principal utiliza API ordinarias de extensión, no CDP, WebDriver, opciones remote-debugging ni `chrome.debugger`. Chromium sigue gestionando la instalación, el acceso a sitios y el ajuste único **Allow User Scripts**. Después de esa configuración, los comandos habituales no adjuntan un depurador ni muestran la confirmación o barra de advertencia de depuración de Chrome.

## Por qué Browser Key Automation

- **Control fluido del navegador que ya tienes delante.** Enumera, crea, selecciona, navega, recarga y cierra pestañas en cualquier momento conservando sesiones, cookies, extensiones y estados de página alcanzados manualmente.
- **Toda la página en una vista del tamaño adecuado para un Agent.** El árbol de operaciones canonical en caché mantiene visible la estructura global, solo expande las ramas solicitadas y conserva el estado de cada Key hasta que cambia el documento. Las vistas puntuales por profundidad, intervalo o subárbol no alteran ese estado.
- **Confianza delimitada por Key, no un endpoint de depuración abierto.** Las Keys Root y Regular tienen permisos, caducidad, nueva revelación, desactivación y revocación explícitos. Las llamadas de una misma Key son seriales; Keys distintas pueden trabajar de forma independiente.
- **Clic nativo con un solo sufijo.** En Windows, `dom.click.real` combina la geometría observada por la extensión con la App local para enviar un clic izquierdo a nivel de sistema operativo cuando una página rechaza la activación DOM sintética. El objetivo debe seguir existiendo, visible, habilitado y sin obstrucciones.
- **Los archivos son de primera clase.** Guarda MHTML, captura el viewport visible, obtiene recursos como Artifacts acotados y los escribe en disco, sube HTML autocontenido y lo abre como demostración sin servidor Web local.
- **Coordinación de varios clientes de confianza.** Una Key puede ocupar una pestaña o el ámbito global para evitar estado inconsistente; otra Key autorizada debe liberar explícitamente la ocupación antes de adquirirla.

### Comparación de flujos de trabajo

Modelos de conexión verificados el 2026-09-01. Se comparan rutas de uso normales, no límites teóricos de funciones.

| Enfoque | Chromium existente con sesión iniciada | Ruta de control habitual | Mejor para |
| --- | --- | --- | --- |
| **Browser Key Automation** | Sí, entre cualquier pestaña autorizada | API ordinarias de extensión + autenticación Key; la App local añade enrutamiento, archivos y clic `.real` opcional | Acceso Agent duradero sin adjuntar depurador, árbol selectivo en caché y flujos de archivo integrados |
| [Playwright](https://playwright.dev/docs/api/class-browsertype), [Puppeteer](https://pptr.dev/guides/browser-management), [Selenium](https://www.selenium.dev/documentation/overview/) | La ruta habitual crea una sesión de automatización; también permiten conectar un Chromium existente | Playwright/CDP, Puppeteer/CDP o WebDriver | Pruebas deterministas, validación entre navegadores, CI y ecosistemas maduros de locators y depuración |
| [Extensión Playwright MCP](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | Sí; un token de perfil puede omitir su propia aprobación posterior | Playwright retransmitido por una extensión que declara el permiso `debugger` de Chrome | Acciones Playwright y accessibility snapshots en pestañas existentes seleccionadas |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | Sí, después de activar remote debugging o exponer un endpoint de depuración | DevTools/CDP; auto-connect de Chrome solicita permiso para cada sesión de depuración | Diagnóstico profundo con Console, Network, Performance, memoria y otros DevTools |
| [Browser MCP](https://browsermcp.io/) | Sí, cuando el usuario conecta la pestaña actual | Extensión + MCP local, limitado a la pestaña de trabajo conectada explícitamente | Una superficie MCP compacta para una pestaña existente elegida |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Sí, entre pestañas | Extensión + native-messaging bridge; el manifest solicita `debugger` además de permisos ordinarios | Herramientas MCP amplias entre pestañas, captura de red, descargas y subida de archivos |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Sí | Agent integrado en el navegador sobre Puppeteer/CDP, con Keys del LLM provider aportadas por el usuario | Una UI multi-Agent integrada en vez de un plano de control independiente del provider |

Browser Key Automation no sustituye las suites de pruebas Playwright/Selenium ni el diagnóstico profundo de DevTools. Cumple otra función: control autorizado y de baja fricción del navegador que una persona ya usa, con una estructura limpia y archivos suficientes para que un Agent complete trabajo real.

> Estado de desarrollo: la compilación de desarrollo unpacked actual está dirigida a Chrome/Chromium 138 o posterior. No es una publicación de Chrome Web Store. La ficha de Store se está preparando; hasta entonces usa [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest). Cada Release tiene exactamente dos descargas: `browser-key-automation-extension-v0.0.0.2.zip` y `browser-key-automation-local-app-v0.0.0.2.zip`.

## Funciones

- Crear, volver a mostrar, copiar, actualizar, desactivar y revocar Keys Root o Regular desde una página de administración local. Una Key completa guardada se puede volver a mostrar más adelante.
- Enumerar pestañas y usar `TabRef`, `DocumentRef`, `NodeRef`, `TreeRef` y `ArtifactRef` vinculados al runtime en lugar de identificadores de navegador sin protección.
- Explorar un árbol de operaciones de página almacenado en caché. El estado expandido pertenece a cada Key y se conserva al salir y volver a una página hasta que el documento se actualice o reemplace.
- Buscar nodos sin expandir el árbol, solicitar vistas puntuales por profundidad, intervalo de hermanos o subárbol, leer live DOM acotado, describir nodos y ejecutar acciones DOM.
- Ejecutar JavaScript en un world `USER_SCRIPT` o `MAIN` explícito cuando **Allow User Scripts** esté habilitado en Chromium.
- Esperar navegación, `interactive`, `complete`, una condición DOM o de texto.
- Guardar la página actual como MHTML, capturar una imagen verificada del viewport, transferir Artifacts acotados y abrir demostraciones HTML autocontenidas sin un servidor HTTP local.
- Enviar un clic izquierdo nativo de Windows con `dom.click.real`, que tiene un permiso independiente de `dom.click`.
- Permitir que una Key ocupe una pestaña o el ámbito global. Otra Key autorizada debe liberar explícitamente esa ocupación antes de adquirirla.

Command Registry es la fuente de verdad para los métodos, schemas, permisos y errores exactos. `system.describe` devuelve la compilación activa y los permisos efectivos de la Key que llama.

## Inicio rápido

### Requisitos

- Chrome o un navegador Chromium compatible, versión 138 o posterior
- App complementaria para Windows x86_64 o Linux x86_64
- Node.js 20 o posterior para la CLI incluida

### 1. Descargar la extensión y la App

Descarga los dos ZIP de la [última Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) y extrae cada uno en una carpeta independiente.

- Extensión: `browser-key-automation-extension-v0.0.0.2.zip`
- App local: `browser-key-automation-local-app-v0.0.0.2.zip`

El ZIP de la App incluye `windows-x86_64/` y `linux-x86_64/`, además de la CLI y el skill de Agent. No hace falta compilar el código fuente.

### 2. Cargar la extensión

1. Extraer por completo el archivo de la extensión.
2. Abrir `chrome://extensions`, habilitar el modo de desarrollador y elegir **Cargar descomprimida**.
3. Seleccionar el directorio extraído cuya raíz contenga directamente `manifest.json`.
4. En los detalles de la extensión, habilitar **Allow User Scripts** y volver a cargarla. Este interruptor controlado por el navegador solo es necesario para `js.execute`; la administración de Keys, el DOM y el árbol de página siguen disponibles sin él.
5. Abrir **Browser Key Automation** desde la barra de herramientas. Crear una Root Key para control plenamente confiable o una Regular Key con solo los permisos necesarios.

La primera instalación abre una página local de configuración. Las actualizaciones y recargas no la abren repetidamente.

### 3. Iniciar la App complementaria

Extraer el archivo App de GitHub Release y mantener en ejecución el relay de la plataforma actual:

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

El endpoint predeterminado es `127.0.0.1:32189`. Si la App no está disponible, la extensión vuelve a intentarlo con el intervalo nominal configurado de 10 segundos hasta conectarse. No iniciar una segunda App si una instancia compatible ya posee el endpoint fijo.

### 4. Conectar la CLI

Desde el directorio extraído de la App local:

```text
node client/browser-key-cli.mjs instances
```

Este comando no requiere una Key. Cero instancias significa que todavía no hay una extensión conectada. Si hay varias, seleccionar explícitamente una `relayEpoch/instanceNumber` actual; nunca probar una bearer Key en todas las instancias.

Proporcionar la Key mediante una variable de entorno, nunca por argv:

```powershell
# PowerShell
$env:BKA_API_KEY = "bk1.<key-id>.<secret>"
node .\client\browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

```bash
# Bash
export BKA_API_KEY='bk1.<key-id>.<secret>'
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json '{}'
```

La CLI vuelve a enumerar las instancias antes de leer la Key. Si delivery se informa como `unknown`, el resultado es realmente desconocido; no se debe reintentar automáticamente un comando con efectos.

## Flujos habituales

- Descubrir una página: `tabs.list` → `page.tree.open` → `page.tree.find` o `page.tree.expand.v2` → `page.tree.view.get`
- Sincronizar: `page.wait`; sin timeout se usan 10 segundos y una condición ya satisfecha devuelve de inmediato.
- Guardar una página: `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`
- Capturar el viewport: `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`
- Abrir una demostración: `node client/browser-key-cli.mjs demo-open ./demo.html`
- Antes de usar un comando desconocido, consultar `skills/browser-key-automation/references/commands.registry.json`. El skill de Agent incluido contiene las mismas referencias generadas.

### Clic nativo `.real`

`dom.click.real` es explícito e independiente de `dom.click`. En Windows solicita a Chromium activar la pestaña de destino y enfocar su ventana, comprueba que el elemento referenciado siga presente, visible, habilitado y sin obstrucciones, y después pide a la App que envíe un único clic izquierdo nativo a la ventana de contenido Chromium correspondiente.

`{ "status": "input_sent" }` solo significa que se aceptó una secuencia de entrada, no que el sitio haya completado la acción de negocio. Se debe observar la página después. Nunca se reproduce automáticamente una entrada nativa desconocida o fallida. La App de Linux no anuncia actualmente `native.input.click.v1`, por lo que la extensión rechaza `.real` antes de preparar la página.

## Keys, permisos y ocupaciones

- Una Key es la única identidad externa. La marca del Agent, el proceso, la cuenta, el socket y la Instance de la App no son identidades de autorización adicionales.
- Root recibe dinámicamente todos los permisos activos. Regular recibe solo los permisos seleccionados explícitamente.
- JavaScript, las acciones DOM normales, la entrada nativa `.real`, el acceso de red y futuros backends de depuración son permisos paralelos; uno no concede silenciosamente los demás.
- Los comandos de una misma Key se serializan en el runtime actual de la extensión. Keys diferentes tienen lanes independientes, aunque sus efectos sobre la misma página pueden competir.
- Una ocupación pertenece a una Key. No hay takeover, force ni replace ocultos: primero release y después acquire.
- La Key completa permanece dentro de la extensión. La página de administración de confianza y los llamantes autorizados por separado para `keys.create` o `keys.reveal` pueden recibirla; las listas y diagnósticos normales no la incluyen. La CLI solo la lee de `BKA_API_KEY` o de una variable de entorno elegida explícitamente.

Una Key potente debe tratarse como una credencial local de control del navegador y entregarse únicamente a Agents o automatizaciones de confianza. Un permiso técnico nunca sustituye la autorización del usuario para pagos, publicaciones, mensajes, cambios de cuenta, eliminaciones u otras acciones importantes.

## Límites del navegador y de plataforma

Chromium sigue controlando host access, páginas restringidas, acceso a file URLs, **Allow User Scripts**, activación de la extensión y cualquier confirmación de depuración de DevTools. Root no puede eludir esos límites.

Las Apps de Windows y Linux ofrecen enrutamiento y escritura de archivos. Windows anuncia además el backend nativo de clic actual; Linux todavía no. El modo incógnito y los derivados de Chromium deben verificarse con su propio perfil y políticas.

Configuración del Agent: [Browser Key Automation skill](skills/browser-key-automation/SKILL.md).

Este proyecto lo mantiene su autor. No se aceptan contribuciones externas ni Pull Requests.
