# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Español | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation permite que un Agent o programa de automatización de confianza controle un navegador Chromium local autorizado mediante una extensión Manifest V3 y una API Key.

La extensión es propietaria de la autenticación de Keys, los permisos, las referencias del navegador, las ocupaciones y las operaciones del navegador. La pequeña App complementaria en Zig solo proporciona enrutamiento local, referencias de Instance asignadas por la App, escritura de archivos y las capacidades nativas que anuncia explícitamente.

> Estado de desarrollo: la compilación de desarrollo unpacked actual está dirigida a Chrome/Chromium 138 o posterior. No es una publicación de Chrome Web Store.

El trabajo de Chrome Web Store está pausado hasta diseñar el icono final. Usa [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases): cada Release tiene exactamente dos descargas, `browser-key-automation-extension-v0.0.0.1.zip` y `browser-key-automation-local-app-v0.0.0.1.zip`. Consulta el [contrato de entrega de GitHub Release](docs/implementation/github-release-delivery.md).

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

## Arquitectura

```text
Agent / automatización
        |
        | BKA_API_KEY + command
        v
App complementaria Zig para Windows o Linux
        |
        | route loopback local + InstanceRef asignada por la App
        v
MV3 offscreen transport
        |
        v
service worker de la extensión
        |
        +-- autenticación de Keys y permisos
        +-- ocupaciones y referencias runtime
        +-- pestañas, árbol de página, DOM, JavaScript y Artifacts
        `-- solicitud opcional de capacidad de plataforma
```

La extensión es la única propietaria del estado de negocio. La App complementaria no conserva una base de datos de Keys ni decide permisos del navegador. La App asigna la referencia de Instance a cada extensión conectada; la extensión nunca inventa ni persiste su propio número de instancia.

La ruta principal utiliza permisos normales de extensión. CDP/DevTools puede seguir siendo una capacidad opcional separada, pero este proyecto no puede eliminar la confirmación de depuración de Chromium.

## Inicio rápido

### Requisitos

- Chrome o un navegador Chromium compatible, versión 138 o posterior
- App complementaria para Windows x86_64 o Linux x86_64
- Node.js 20 o posterior para la CLI incluida
- Zig solo para compilar la App desde el código fuente

### 1. Compilar los paquetes separados

```text
npm ci
npm run build:dev-package
```

La compilación produce tres archivos independientes:

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

La extensión y la App local se entregan por separado de forma deliberada. Cada archivo contiene su propio `START-HERE.md` y `SHA256SUMS.txt`.

`npm run build:github-release` agrupa esos intermedios verificados en dos assets para GitHub: un ZIP de extensión y un ZIP de App con los relays `windows-x86_64/` y `linux-x86_64/`, más una sola copia compartida de la CLI, el protocolo y el skill de Agent.

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

Los intermedios App `-dev` por plataforma aún colocan el relay en la raíz del archivo; sigue el `START-HERE.md` incluido al usarlos.

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

## Desarrollo

| Comando | Propósito |
|---|---|
| `npm run generate` | Generar proyecciones de comandos, UI, transporte, capacidades y Freedom Points |
| `npm run check:extension` | Regenerar y comprobar tipos de todos los realms de la extensión |
| `npm run build` | Compilar la extensión y la App Zig de la plataforma actual |
| `npm run test:unit` | Pruebas unitarias de UI, Key, runtime, WebSocket y Zig |
| `npm run test:runtime` | Pruebas unitarias más integración aislada relay/Chromium |
| `npm run build:dev-package` | Crear la extensión y las Apps de ambas plataformas |
| `npm run build:github-release` | Crear exactamente los dos ZIP publicados en GitHub Releases |
| `npm run build:chrome-web-store:first-upload` | Crear el artefacto de identidad pausado; no subirlo antes de reanudar el trabajo del icono |
| `npm run test:dev-package-smoke` | Verificar estructura, ejecutables, hashes y referencias del skill |

Las pruebas de integración aisladas usan puertos, perfiles y procesos relay temporales. No deben apuntar a un perfil de navegador personal ni a una Instance de App personal ya existente.

## Documentación

- [Índice de documentación](docs/README.md)
- [Decisiones actuales](docs/decisions.md)
- [Progreso y estado verificado](docs/PROGRESS.md)
- [Contrato de comandos](docs/contracts/commands.md)
- [Árbol de operaciones de página](docs/design/page-information-tree.md)
- [Freedom Points](docs/design/freedom-points.md)
- [Estructura de entrega](docs/design/delivery-layout.md)
- [Skill de Agent](skills/browser-key-automation/SKILL.md)

Las propuestas antiguas Cleaner/PageIR se conservan únicamente en `docs/historical/` y no describen el comportamiento actual del producto.
