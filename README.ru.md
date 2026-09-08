# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | Русский

**Ваш привычный браузер — теперь и для Agent.**

Agent может продолжить работу в Chromium-вкладках с уже выполненным входом: читать страницы и выполнять нужные действия, бесшовно принимая управление.

## Что становится проще

- **Читайте нужными частями.** Кэшированное дерево сохраняет общую структуру и раскрывает только запрошенные ветви. Состояние переживает переключение вкладок, пока документ не изменился. Глубина, диапазон и поддерево — разовые представления, а не очистка с потерей данных.
- **Работайте между вкладками.** Явные ссылки, последовательные команды каждого Key и занятие вкладки, окна или глобальной области уменьшают конфликты.
- **Забирайте результат.** MHTML, снимки страницы или Canvas-элемента, передача ресурсов и HTML-демонстрации без локального веб-сервера.
- **Выбирайте способ ввода.** DOM, реальный ввод Windows, независимые виртуальные мышь и клавиатура, дополнительный CDP.
- **Проверяйте эффект.** `ensure.run` объединяет условия, ограниченную подготовку, действие и наблюдаемую цель. Неизвестный результат не вызывает слепого повторения.

## Начало работы

> Каждая новая установка создаёт одинаковый **публичный пробный Root Key**, указанный в Agent skill. Это не личный секрет. В личном браузере создайте частный Key, переключите клиентов и отзовите пробный. Само создание нового Key не отключает старый. Обновления не восстанавливают его.

1. Нужны Chromium **138+**, Windows или Linux x64 и **Node.js 20+** для CLI. Скачайте оба ZIP из [последнего релиза](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) и распакуйте отдельно.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. Включите режим разработчика в `chrome://extensions` и загрузите папку с `manifest.json`. Управление Keys открывается значком расширения. Для `js.execute` нужен **Allow User Scripts**, для DOM и дерева — нет.

3. Запустите App командами ниже. В Windows оставьте `virtual-mouse-hook.dll` рядом с EXE. При отсутствии соединения расширение повторяет подключение к `127.0.0.1:32189` примерно каждые 10 секунд.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Подключите к Agent файл `skill/browser-key-automation/SKILL.md` из пакета. Получите список экземпляров и выберите браузер. Передавайте частный Key через `BKA_API_KEY`, не через аргументы; не проверяйте его на всех экземплярах подряд.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## От страницы к результату

`system.describe` сообщает сборку и действующие права. Точные параметры приведены в [реестре команд](dev/skills/browser-key-automation/references/commands.registry.json).

| | API / CLI |
| --- | --- |
| Исследовать, выбрать, раскрыть | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| Ждать условия страницы | `page.wait` · `ensure.run` |
| Сохранить / снять страницу или элемент | `page-save` · `page-shot` · `element-shot` |
| Передать и показать HTML | `demo-open` |
| DOM / реальный щелчок | `dom.click` · `dom.click.real` |
| Текст / сочетания / отпустить клавиши | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| Виртуальные мышь / клавиатура | `virtualMouse.*` · `virtualKeyboard.*` |
| Измерить цель ввода | `input.calibrate` |
| Библиотека действий | `actions.create` · `actions.list/get` · `actions.run` |
| Запись DOM / Windows | `recording.start/pause/resume/stop` → `actions.compile` |
| Загрузка файлов и диалоги | `files.upload` · `downloads.*` · `dialogs.*` |
| Сеть и диагностика | `network.*` · `console.*` · `performance.*` |
| Вся страница / область / элемент | `page.screenshot.fullPage/region/element` |
| Данные браузера и поиск | `search.tabs` · `semantic.search` · `bookmarks.*` · `history.*` |
| Окно и область просмотра | `windows.*` · `page.viewport.get` · `page.zoom.set` |
| Явный сеанс CDP | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

Сохраните последовательность команд или скомпилируйте запись, проверьте условия и запустите её по ID действия. Запись Windows сохраняет изменения окна и исключает траектории мыши за пределами целевого окна. App записывает координаты относительно окна и обе боковые кнопки. Права, подготовка и ограничения описаны в [руководстве по действиям и записи](dev/skills/browser-key-automation/references/actions-and-recording.md).

## Keys и границы ввода

- Root получает все активные права. Regular Keys поддерживают раскрываемые группы прав, срок действия, повторный просмотр, отключение и отзыв. JavaScript и нативный ввод разрешаются независимо. Key не заменяет согласие на оплату, публикацию или удаление.
- Команда проходит аутентификацию один раз при отправке. В очереди и при выполнении действуют полученные тогда права; последующее истечение срока, отключение или отзыв Key влияет только на новые команды. Собственные сроки выполнения и явные команды остановки и освобождения ресурсов сохраняются.
- Виртуальное состояние принадлежит Key, сохраняется между вкладками и требует занятия всего целевого окна. Обычным виртуальным действиям нужен действующий `input.calibrate`; `ensure.run` проверяет и обновляет его при необходимости. Реальный ввод требует переднего плана; виртуальный не перемещает физический курсор.
- Windows предоставляет нативный ввод. Linux пока предоставляет маршрутизацию браузера и файлы, без нативного ввода. Свёрнутые окна не поддерживаются. Первая калибровка требует измеримой страницы; повторное использование при перекрытии условно. Первичная калибровка нескольких окон и полноценное нативное HTML5/OLE-перетаскивание имеют нерешённые случаи.
- Снимки элементов используют видимую область и поддерживаемые маски формы, не восстанавливая скрытые пиксели. Chrome управляет закрытыми страницами, доступом к сайтам и User Scripts; `debugger.attach` сохраняет уведомление отладчика. Синтетические события и виртуальные сообщения не обходят все ограничения ввода.

## Когда выбирать

BKA — на сегодня самое полное расширение автоматизации браузера для персональных ИИ-ассистентов. Разрешите доступ один раз и пользуйтесь в любой момент. Пусть Agent станет вашим настоящим помощником.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | Кросс-браузерные тесты и CI |
| [Puppeteer](https://pptr.dev/) | Программируемая автоматизация |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Agent-инструменты со снимками доступности |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Глубокая диагностика браузера |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | MCP-инструменты для существующего браузера |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Интерфейс Agent внутри браузера |

## Руководства и поддержка

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

Интерфейс расширения доступен на 20 языках, README — в десяти вариантах. [Конфиденциальность](PRIVACY.md) · [Структура разработки](dev/README.md). Проект поддерживает автор; внешние вклады и Pull Request не принимаются.
