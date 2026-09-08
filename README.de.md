# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Deutsch | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**Der Browser, den Sie nutzen. Jetzt auch für Ihren Agent.**

Ihr Agent kann bereits angemeldete Chromium-Tabs nahtlos übernehmen, Seiten nach Bedarf lesen und Aktionen ausführen.

## Was es erleichtert

- **Weniger auf einmal lesen.** Der gecachte Operationsbaum bewahrt die Gesamtstruktur und öffnet nur gewünschte Zweige. Der Zustand bleibt beim Tabwechsel erhalten, solange sich das Dokument nicht ändert. Tiefe, Bereich und Teilbaum sind einmalige Ansichten, keine verlustbehaftete Seitenbereinigung.
- **Tabübergreifend arbeiten.** Explizite Referenzen, serielle Ausführung je Key und Belegung von Tabs, Fenstern oder dem Gesamtsystem reduzieren Konflikte.
- **Ergebnisse mitnehmen.** MHTML, Seiten- und Canvas-Bilder, Ressourcentransfer und HTML-Demos ohne lokalen Webserver.
- **Passende Eingabe wählen.** DOM, echte Windows-Eingabe, unabhängige virtuelle Maus/Tastatur und optionales CDP.
- **Ergebnisse prüfen.** `ensure.run` verbindet Bedingungen, begrenzte Vorbereitung, Aktion und beobachtbares Ziel. Unbekannte Ergebnisse lösen keine blinde Wiederholung aus.

## Erste Schritte

> Jede Neuinstallation erstellt denselben **öffentlichen Root-Test-Key**, dessen Wert im Agent-Skill steht. Er ist kein privates Geheimnis. Im persönlichen Browser einen privaten Key erstellen, Clients umstellen und den Test-Key widerrufen. Das Erstellen allein deaktiviert ihn nicht. Updates stellen ihn nicht wieder her.

1. Voraussetzungen: Chromium **138+**, Windows oder Linux x64 und **Node.js 20+** für die CLI. Beide ZIPs aus dem [neuesten Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) getrennt entpacken.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. Unter `chrome://extensions` den Entwicklermodus aktivieren und den Ordner mit `manifest.json` laden. Keys über das Symbol verwalten. **Allow User Scripts** wird für `js.execute` benötigt, nicht für DOM und Baum.

3. Die App mit den Befehlen unten starten. Unter Windows bleibt `virtual-mouse-hook.dll` neben der EXE. Die Erweiterung versucht etwa alle 10 Sekunden erneut, `127.0.0.1:32189` zu erreichen.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Dem Agent den mitgelieferten `skill/browser-key-automation/SKILL.md` geben. Instanzen auflisten und den Zielbrowser wählen. Private Keys über `BKA_API_KEY`, nie als CLI-Argument übergeben; nicht an allen Instanzen ausprobieren.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## Von der Seite zum Ergebnis

`system.describe` meldet Build und wirksame Rechte. Genaue Parameter stehen im [Befehlsregister](dev/skills/browser-key-automation/references/commands.registry.json).

| | API / CLI |
| --- | --- |
| Erkunden, auswählen, aufklappen | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| Seitenbedingung abwarten | `page.wait` · `ensure.run` |
| Seite speichern / Bildschirm / Element | `page-save` · `page-shot` · `element-shot` |
| HTML übertragen und anzeigen | `demo-open` |
| DOM / echter Klick | `dom.click` · `dom.click.real` |
| Text / Tastenkürzel / Tasten lösen | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| Virtuelle Maus / Tastatur | `virtualMouse.*` · `virtualKeyboard.*` |
| Eingabeziel vermessen | `input.calibrate` |
| Aktionsbibliothek | `actions.create` · `actions.list/get` · `actions.run` |
| DOM- / Windows-Aufzeichnung | `recording.start/pause/resume/stop` → `actions.compile` |
| Uploads, Downloads und Dialoge | `files.upload` · `downloads.*` · `dialogs.*` |
| Netzwerk und Diagnose | `network.*` · `console.*` · `performance.*` |
| Ganze Seite / Bereich / Element | `page.screenshot.fullPage/region/element` |
| Browserdaten und Suche | `search.tabs` · `semantic.search` · `bookmarks.*` · `history.*` |
| Fenster und Viewport | `windows.*` · `page.viewport.get` · `page.zoom.set` |
| Explizite CDP-Sitzung | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

Befehlsfolgen lassen sich direkt speichern oder aus einer Aufzeichnung kompilieren, prüfen und per Aktions-ID wiedergeben. Die Windows-Aufzeichnung erfasst Fensteränderungen und lässt Mauspfade außerhalb des Zielfensters weg. Die App erfasst relative Fensterkoordinaten und beide Seitentasten. Berechtigungen, Vorbereitung und Wiedergabegrenzen stehen unter [Aktionen und Aufzeichnung](dev/skills/browser-key-automation/references/actions-and-recording.md).

## Keys und Eingabegrenzen

- Root erhält alle aktiven Rechte. Regular Keys bieten aufklappbare Berechtigungsgruppen, Ablaufdatum, erneute Anzeige, Deaktivierung und Widerruf. JavaScript und native Eingabe sind unabhängige Rechte. Ein Key ersetzt keine Zustimmung zu Zahlungen, Veröffentlichungen oder Löschungen.
- Befehle werden einmal beim Einreichen authentifiziert. In der Warteschlange und während der Ausführung gelten die dabei erteilten Rechte; ein späterer Ablauf, eine Deaktivierung oder ein Widerruf des Keys betrifft nur neue Befehle. Eigene Zeitlimits sowie ausdrückliches Stoppen und Freigeben bleiben wirksam.
- Virtueller Eingabezustand gehört dem Key, bleibt tabübergreifend erhalten und verlangt die Belegung des gesamten Zielfensters. Normale virtuelle Eingabeaktionen benötigen eine gültige `input.calibrate`-Messung; `ensure.run` prüft und erneuert sie bei Bedarf. Echte Eingabe verlangt das Vordergrundfenster; virtuelle Eingabe bewegt den physischen Cursor nicht.
- Windows bietet native Eingabe. Linux bietet derzeit Browser-Routing und Dateien, keine nativen Eingabebackends. Minimierte Fenster sind nicht unterstützt. Die erste Kalibrierung braucht eine messbare Seite; Wiederverwendung bei Verdeckung ist bedingt. Mehrfenster-Erstkalibrierung und vollständiges natives HTML5/OLE-Drag-and-drop haben offene Fälle.
- Elementbilder verwenden sichtbare Viewport-Pixel und unterstützte Formmasken. Chrome kontrolliert geschützte Seiten, Websitezugriff und User Scripts; `debugger.attach` behält die Debugging-Anzeige. Synthetische Ereignisse und virtuelle Fensternachrichten umgehen nicht jede Eingabebeschränkung.

## Einordnung

BKA ist derzeit die umfassendste Browserautomatisierungs-Erweiterung für persönliche KI-Assistenten. Einmal autorisieren, jederzeit nutzen. So wird Ihr Agent zu Ihrem persönlichen Assistenten.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | Browserübergreifende Tests und CI |
| [Puppeteer](https://pptr.dev/) | Programmierbare Automatisierung |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Agent-Werkzeuge mit Accessibility-Snapshots |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Tiefe Browserdiagnose |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | MCP-Werkzeuge für bestehende Browser |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Agent-Oberfläche im Browser |

## Anleitungen und Pflege

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

Die Erweiterungsoberfläche bietet 20 Sprachen, die READMEs zehn Sprachvarianten. [Datenschutz](PRIVACY.md) · [Entwicklungsstruktur](dev/README.md). Vom Autor gepflegt; externe Beiträge und Pull Requests werden nicht angenommen.
