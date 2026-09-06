# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Español | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**Tu navegador de siempre, también para tu Agent.**

Tu Agent puede tomar el control de tus pestañas Chromium con la sesión ya iniciada, leer páginas y realizar las acciones que necesites sin interrupciones.

## Qué facilita

- **Leer solo lo necesario.** El árbol en caché conserva la estructura global y expande las ramas solicitadas. El estado permanece al cambiar de pestaña mientras no cambie el documento. Profundidad, intervalo y subárbol son vistas puntuales, no limpieza con pérdida.
- **Trabajar entre pestañas.** Referencias explícitas, ejecución secuencial por Key y ocupación de pestañas, ventanas o ámbito global reducen conflictos.
- **Llevarte el resultado.** MHTML, capturas de página o elementos Canvas, transferencia de recursos y demostraciones HTML sin servidor local.
- **Elegir la entrada.** DOM, entrada real de Windows, ratón/teclado virtuales independientes y CDP opcional.
- **Comprobar efectos.** `ensure.run` une condiciones, preparación acotada, acción y objetivo observable. Un resultado desconocido no provoca repeticiones a ciegas.

## Primeros pasos

> Cada instalación nueva crea la misma **Key Root pública de prueba**, incluida en el skill del Agent. No es una credencial privada. En un navegador personal, crea una Key privada, cambia los clientes y revoca la de prueba. Crear otra no desactiva la anterior. Las actualizaciones no la restauran.

1. Necesitas Chromium **138+**, Windows o Linux x64 y **Node.js 20+** para la CLI. Descarga los dos ZIP de la [última versión](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) y extráelos por separado.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. En `chrome://extensions`, activa el modo desarrollador y carga la carpeta con `manifest.json`. Gestiona Keys desde el icono. **Allow User Scripts** es necesario para `js.execute`, no para DOM ni árboles.

3. Inicia la App con las órdenes de abajo. En Windows, conserva `virtual-mouse-hook.dll` junto al ejecutable. La extensión reintenta `127.0.0.1:32189` aproximadamente cada 10 segundos.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Carga el `skill/browser-key-automation/SKILL.md` incluido en tu Agent. Enumera instancias y elige el navegador. Pasa la Key privada mediante `BKA_API_KEY`, nunca como argumento, y no la pruebes en todas las instancias.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## De la página al resultado

Consulta versión y permisos con `system.describe`; los parámetros exactos están en el [registro de órdenes](dev/skills/browser-key-automation/references/commands.registry.json).

| | API / CLI |
| --- | --- |
| Explorar, seleccionar, expandir | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| Esperar una condición | `page.wait` · `ensure.run` |
| Guardar página / capturar página o elemento | `page-save` · `page-shot` · `element-shot` |
| Subir y mostrar HTML | `demo-open` |
| DOM / clic real | `dom.click` · `dom.click.real` |
| Texto / atajos / soltar teclas | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| Ratón / teclado virtual | `virtualMouse.*` · `virtualKeyboard.*` |
| Medir el destino nativo | `input.calibrate` |
| Sesión CDP explícita | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Keys y límites de entrada

- Root obtiene todos los permisos activos. Las Keys Regular ofrecen grupos desplegables, caducidad, consulta posterior, desactivación y revocación. JavaScript y entrada nativa son permisos independientes. Una Key no sustituye el consentimiento para pagar, publicar o borrar.
- El estado virtual pertenece a la Key, persiste entre pestañas y requiere ocupar toda la ventana destino. Las acciones virtuales normales usan un `input.calibrate` válido; `ensure.run` lo comprueba y actualiza si hace falta. La entrada real exige primer plano; la virtual no mueve el cursor físico.
- Windows ofrece entrada nativa. Linux ofrece actualmente enrutamiento del navegador y archivos, no entrada nativa. No se admiten ventanas minimizadas. La calibración inicial requiere una página medible; reutilizarla con la ventana tapada tiene condiciones. Siguen pendientes casos de calibración inicial multiventana y arrastre HTML5/OLE nativo completo.
- Las imágenes de elementos usan el viewport visible y máscaras de formas compatibles. Chrome controla páginas restringidas, acceso a sitios y User Scripts; `debugger.attach` mantiene el aviso de depuración. Eventos sintéticos y mensajes virtuales no eluden todas las restricciones.

## Cuándo elegirlo

BKA es actualmente la extensión de automatización de navegador más completa para asistentes personales de IA. Autoriza una vez y úsala cuando quieras. Convierte tu Agent en un verdadero asistente personal.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | Pruebas multinavegador y CI |
| [Puppeteer](https://pptr.dev/) | Automatización programable |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Herramientas Agent con instantáneas de accesibilidad |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Diagnóstico profundo del navegador |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Herramientas MCP para navegadores existentes |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Interfaz Agent en el navegador |

## Guías y mantenimiento

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

La interfaz ofrece 20 idiomas; los README tienen diez variantes. [Privacidad](PRIVACY.md) · [Estructura de desarrollo](dev/README.md). Mantenido por el autor; no se aceptan contribuciones externas ni Pull Requests.
