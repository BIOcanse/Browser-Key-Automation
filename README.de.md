# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Deutsch | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation macht den bereits genutzten Chromium-Browser zu einer Key-begrenzten Automatisierungsoberfläche für vertrauenswürdige Agents und Programme. Nach einmaliger Installation und Erstellung eines Keys kann ein berechtigter Client über vorhandene, angemeldete Tabs hinweg arbeiten, ohne einen separaten Automatisierungsbrowser zu starten.

Der Hauptpfad verwendet gewöhnliche Erweiterungs-APIs, nicht CDP, WebDriver, remote-debugging-Schalter oder `chrome.debugger`. Installation, Websitezugriff und die einmalige Einstellung **Allow User Scripts** bleiben unter Kontrolle von Chromium. Danach hängen alltägliche Browserbefehle keinen Debugger an und zeigen weder Chromes Bestätigungsdialog noch seine Warnleiste für Debugging an.

## Warum Browser Key Automation?

- **Nahtlose Kontrolle des Browsers, der bereits vor Ihnen steht.** Tabs jederzeit auflisten, erstellen, auswählen, navigieren, neu laden und schließen, während echte Anmeldungen, Cookies, Erweiterungen und manuell erreichte Seitenzustände erhalten bleiben.
- **Eine vollständige Seite in Agent-gerechter Größe.** Der zwischengespeicherte canonical Operationsbaum hält die Gesamtstruktur sichtbar, klappt nur angeforderte Zweige auf und bewahrt den Zustand jedes Keys bis zum Dokumentwechsel. Einmalige Tiefen-, Bereichs- und Teilbaumansichten verändern diesen Zustand nicht.
- **Zustandsänderungen mit nachweisbarem Ergebnis.** `ensure.run` verbindet eine strikte Bedingung, genau eine registrierte Browseraktion, begrenzte Vorbereitung und ein beobachtbares Ziel unter einer gemeinsamen Frist. Aktuelle iframe-Pfade werden bei jeder Beobachtung neu aufgelöst, die Suche durch verschachtelte Scrollbereiche erreicht virtuelle Listen, und jeder angenommene Aufruf liefert eine begrenzte, bereinigte Trace-Referenz im Besitz des Keys. Nicht wiederholbare Aktionen werden nach dem Senden nie erneut ausgeführt; ein nicht beweisbares Ergebnis heißt `unknown`.
- **Key-begrenztes Vertrauen statt eines offenen Debugging-Endpunkts.** Root- und Regular-Keys besitzen explizite Berechtigungen, Ablauf, erneute Anzeige, Deaktivierung und Widerruf. Aufrufe desselben Keys laufen seriell; verschiedene Keys können unabhängig arbeiten.
- **Nativer Klick mit einem Suffix.** Unter Windows verbindet `dom.click.real` die von der Erweiterung ermittelte Elementgeometrie mit der lokalen App und sendet einen OS-Linksklick, wenn eine Seite synthetische DOM-Aktivierung ablehnt. Das Ziel muss weiterhin vorhanden, sichtbar, aktiv und unverdeckt sein.
- **Dateien als vollwertige Funktion.** Seiten als MHTML speichern, den sichtbaren Viewport erfassen, Ressourcen als begrenzte Artifacts abrufen und auf Datenträger schreiben, eigenständiges HTML hochladen und ohne lokalen Webserver als Browserdemo öffnen.
- **Koordination mehrerer vertrauenswürdiger Clients.** Ein Key kann einen Tab oder den globalen Bereich belegen, um inkonsistenten Zustand zu vermeiden. Ein anderer berechtigter Key muss diese Belegung ausdrücklich freigeben, bevor er sie übernimmt.

### Workflow-Vergleich

Verbindungsmodelle geprüft am 2026-09-01. Verglichen werden normale Arbeitsabläufe, nicht theoretische Funktionsobergrenzen.

| Ansatz | Vorhandenes angemeldetes Chromium | Normaler Steuerpfad | Am besten geeignet für |
| --- | --- | --- | --- |
| **Browser Key Automation** | Ja, über beliebige berechtigte Tabs hinweg | Gewöhnliche Erweiterungs-APIs + Key-Authentifizierung; die lokale App ergänzt Routing, Dateien und den optionalen `.real`-Klick | Dauerhaften vertrauenswürdigen Agent-Zugriff ohne Debugger-Anhang, selektiven Cache-Baum und integrierte Dateiabläufe |
| [Playwright](https://playwright.dev/docs/api/class-browsertype), [Puppeteer](https://pptr.dev/guides/browser-management), [Selenium](https://www.selenium.dev/documentation/overview/) | Der Normalfall erstellt eine Automatisierungssitzung; vorhandenes Chromium kann ebenfalls verbunden werden | Playwright/CDP, Puppeteer/CDP oder WebDriver | Deterministische Tests, browserübergreifende Prüfung, CI und ausgereifte Locator-/Debugging-Ökosysteme |
| [Playwright MCP-Erweiterung](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | Ja; ein Profile-Token kann die eigene spätere Verbindungsfreigabe entfernen | Playwright über eine Erweiterung, die Chromes `debugger`-Berechtigung deklariert | Playwright-Aktionen und Accessibility-Snapshots auf ausgewählten vorhandenen Tabs |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | Ja, nach Aktivierung von Remote Debugging oder Freigabe eines Debugging-Endpunkts | DevTools/CDP; Chromes Auto-connect verlangt die Zustimmung für jede Debugging-Sitzung | Tiefe Diagnose mit Console, Network, Performance, Speicher und weiteren DevTools |
| [Browser MCP](https://browsermcp.io/) | Ja, nachdem der Benutzer den aktuellen Tab verbindet | Erweiterung + lokaler MCP für den ausdrücklich verbundenen Arbeitstab | Eine kompakte MCP-Oberfläche für einen ausgewählten vorhandenen Tab |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Ja, tabübergreifend | Erweiterung + native-messaging bridge; das Manifest fordert zusätzlich `debugger` an | Breite tabübergreifende MCP-Werkzeuge, Netzwerkerfassung, Downloads und Datei-Upload |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Ja | Integrierter Browser-Agent auf Puppeteer/CDP mit vom Benutzer gelieferten LLM-provider Keys | Eine gebündelte Multi-Agent-UI statt einer provider-neutralen Browsersteuerung |

Browser Key Automation ersetzt weder Playwright-/Selenium-Testsuiten noch tiefe DevTools-Diagnosen. Es erfüllt eine andere Aufgabe: reibungsarme, berechtigte Kontrolle des Browsers, den ein Mensch bereits benutzt, mit einer klaren Struktur und Dateiwerkzeugen für praktische Agent-Aufgaben.

> Verteilung: [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) stellt eine entpackte Erweiterung für Chrome/Chromium ab Version 138 und eine separate lokale App bereit. Die Veröffentlichung im Chrome Web Store folgt einem eigenen Verfahren. Jedes Release hat genau zwei Downloads: `browser-key-automation-extension-v0.0.0.4.zip` und `browser-key-automation-local-app-v0.0.0.4.zip`.

## Funktionen

- Root- und Regular-Keys in einer lokalen Verwaltungsseite erstellen, erneut anzeigen, kopieren, aktualisieren, deaktivieren und widerrufen. Ein gespeicherter vollständiger Key kann später erneut angezeigt werden.
- Tabs auflisten und laufzeitgebundene `TabRef`-, `DocumentRef`-, `NodeRef`-, `TreeRef`- und `ArtifactRef`-Werte statt roher Browser-IDs verwenden.
- Einen zwischengespeicherten Seiten-Operationsbaum erkunden. Der Aufklappzustand gehört zum jeweiligen Key und bleibt beim Seitenwechsel erhalten, bis das Dokument neu geladen oder ersetzt wird.
- Knoten finden, ohne den Baum aufzuklappen, und einmalige Ansichten nach Tiefe, Geschwisterbereich oder Teilbaum abrufen; begrenztes Live-DOM lesen, Knoten beschreiben und DOM-Aktionen ausführen.
- JavaScript in einer ausdrücklich gewählten `USER_SCRIPT`- oder `MAIN`-World ausführen, wenn Chromium **Allow User Scripts** aktiviert hat.
- Auf Navigation, `interactive`, `complete`, DOM- oder Textbedingungen warten.
- Die aktuelle Seite als MHTML speichern, ein verifiziertes Viewport-Bild erfassen, begrenzte Artifacts übertragen und eigenständige HTML-Demos ohne lokalen HTTP-Server öffnen.
- Mit `dom.click.real` einen ausdrücklichen nativen Windows-Linksklick senden. Die Berechtigung ist von normalem `dom.click` unabhängig.
- Text mit `dom.insertText` am aktuellen Cursor einfügen oder native Windows-Tastaturbefehle für exakten Text, menschlich getakteten Text, benannte Tasten, beliebige Tastenkürzel, ausdrückliche down/up-Zustände und Instance-bezogenes Zurücksetzen verwenden.
- Einen Tab oder den globalen Bereich durch einen Key belegen. Ein anderer berechtigter Key muss die Belegung ausdrücklich freigeben, bevor er sie selbst erwirbt.

Die Command Registry ist die maßgebliche Quelle für exakte Methoden, Schemas, Berechtigungen und Fehler. `system.describe` meldet den aktiven Build und die effektiven Berechtigungen des aufrufenden Keys.

## Schnellstart

### Voraussetzungen

- Chrome oder ein kompatibler Chromium-Browser ab Version 138
- Windows x86_64 oder Linux x86_64 für die Begleit-App
- Node.js 20 oder neuer für die mitgelieferte CLI

### 1. Erweiterung und App herunterladen

Laden Sie beide ZIP-Dateien aus dem [neuesten Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) herunter und entpacken Sie jede in ein eigenes Verzeichnis.

- Erweiterung: `browser-key-automation-extension-v0.0.0.4.zip`
- Lokale App: `browser-key-automation-local-app-v0.0.0.4.zip`

Die App-ZIP enthält `windows-x86_64/` und `linux-x86_64/` sowie CLI und Agent-Skill. Ein Build aus dem Quellcode ist nicht erforderlich.

### 2. Erweiterung laden

1. Das Erweiterungsarchiv vollständig entpacken.
2. `chrome://extensions` öffnen, den Entwicklermodus aktivieren und **Entpackte Erweiterung laden** wählen.
3. Das entpackte Verzeichnis wählen, in dessen Wurzel direkt `manifest.json` liegt.
4. Auf der Detailseite **Allow User Scripts** aktivieren und die Erweiterung neu laden. Dieser vom Browser verwaltete Schalter ist nur für `js.execute` erforderlich; Key-Verwaltung, DOM und Seitenbaum funktionieren auch ohne ihn.
5. **Browser Key Automation** über die Symbolleiste öffnen. Für vollständig vertrauenswürdige Kontrolle einen Root Key, für einen begrenzten Umfang einen Regular Key mit den benötigten Berechtigungen erstellen.

Bei der ersten Installation öffnet sich eine lokale Einrichtungsseite. Updates und erneutes Laden öffnen sie nicht wiederholt.

### 3. Begleit-App starten

Das App-Archiv des GitHub Release entpacken und das Relay der aktuellen Plattform weiterlaufen lassen:

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

Der Standard-Endpunkt ist `127.0.0.1:32189`. Ist die App nicht erreichbar, versucht die Erweiterung im konfigurierten nominellen Abstand von 10 Sekunden weiter zu verbinden. Keine zweite App starten, wenn der feste Endpunkt bereits einer kompatiblen Instanz gehört.

### 4. CLI verbinden

Im entpackten Verzeichnis der lokalen App ausführen:

```text
node client/browser-key-cli.mjs instances
```

Dieser Befehl benötigt keinen Key. Null Instanzen bedeuten, dass noch keine Erweiterung verbunden ist. Bei mehreren Instanzen muss eine aktuelle `relayEpoch/instanceNumber` ausdrücklich gewählt werden; ein Bearer-Key darf nicht gegen alle Instanzen ausprobiert werden.

Den Key ausschließlich über eine Umgebungsvariable, nie über argv, bereitstellen:

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

Die CLI listet Instanzen erneut auf, bevor sie den Key liest. Wird delivery als `unknown` gemeldet, ist das Ergebnis tatsächlich unbekannt; wirkungsbehaftete Befehle dürfen nicht automatisch wiederholt werden.

## Häufige Abläufe

- Seitenerkundung: `tabs.list` → `page.tree.open` → `page.tree.find` oder `page.tree.expand.v2` → `page.tree.view.get`
- Seitensynchronisierung: `page.wait`; ohne timeout gelten 10 Sekunden, eine bereits erfüllte Bedingung kehrt sofort zurück.
- Seite speichern: `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`
- Viewport erfassen: `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`
- Demo öffnen: `node client/browser-key-cli.mjs demo-open ./demo.html`
- Vor einem unbekannten Befehl `skills/browser-key-automation/references/commands.registry.json` lesen. Der mitgelieferte Agent-Skill enthält dieselben generierten Referenzen.

### Elementbilder und explizites Debugging

Mit `page.screenshot.element` betrachtet ein Agent Canvas, Diagramme oder Container über eine vorhandene NodeRef. Sichtbare Kindelemente werden einbezogen, unterstützte Formen maskiert und proportional in einem transparenten PNG der exakten Zielgröße zentriert. Bildschirmkoordinaten und Debugger-Verbindungen sind dafür nicht nötig.

```text
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
```

Für tiefere Diagnose dient `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach`. Die unabhängige Berechtigung `debugger` bietet CDP-Befehle und -Ereignisse; Chromes eigene Debugging-Bestätigung und Warnung bleiben bestehen. Gewöhnliche Erweiterungsoperationen behalten ihren bisherigen Pfad.

Die Elementaufnahme erfasst nur den aktuellen Viewport eines bereits aktiven Tabs, ohne automatisches Scrollen oder Rekonstruktion verborgener Inhalte. Unterstützte Formen, Beschränkung auf das Hauptdokument, Teilbereiche, große CDP-Ergebnisse und Fehlerverhalten stehen im [Agent-Leitfaden](skills/browser-key-automation/references/debugger-and-element-capture.md).

### Nativer `.real`-Klick

`dom.click.real` ist ausdrücklich und von `dom.click` unabhängig. Unter Windows fordert es Chromium auf, den Ziel-Tab zu aktivieren und sein Browserfenster zu fokussieren, prüft, ob das referenzierte Element aktuell, sichtbar, aktiviert und unverdeckt ist, und bittet dann die App um genau einen nativen Linksklick im passenden Chromium-Inhaltsfenster.

`{ "status": "input_sent" }` bedeutet nur, dass eine Eingabesequenz angenommen wurde, nicht dass die Website den gewünschten Geschäftsvorgang abgeschlossen hat. Die Seite muss anschließend beobachtet werden. Unbekannte oder fehlgeschlagene native Eingaben dürfen nie automatisch wiederholt werden. Die Linux-App kündigt `native.input.click.v1` derzeit nicht an; dort lehnt die Erweiterung `.real` vor jeder Seitenvorbereitung ab.

### Native Tastatureingabe

`keyboard.type` sendet exakten Unicode-Text sofort; `keyboard.typeHuman` ist der getrennte, begrenzte Modus mit menschlicher Taktung. `keyboard.press` akzeptiert benannte Tasten und Akkorde: Ein einfacher Name führt immer ein vollständiges Drücken und Loslassen aus, während ein Aktionsarray raw `down`/`up` bewusst über Befehle hinweg halten kann. `keyboard.reset` löst nur Tasten der aktuellen Erweiterungs-Instance. `dom.insertText` bleibt eine getrennte, nicht vertrauenswürdige DOM-Einfügung an Cursor oder Auswahl.

Native Tastaturbefehle zielen auf eine NodeRef oder TabRef und verlangen das exakte Chromium-Fenster im Vordergrund. Ändert sich Ziel oder Vordergrund oder erscheinen konkurrierende physische Tasten, stoppt die App vor weiterer Eingabe; angenommene Effekte werden nie wiederholt. Windows kündigt `native.input.keyboard.v1` an, Linux derzeit nicht.

## Keys, Berechtigungen und Belegung

- Ein Key ist die einzige externe Identität. Agent-Marke, Prozess, Konto, Socket und App-Instance sind keine zusätzlichen Autorisierungsidentitäten.
- Root besitzt dynamisch alle aktiven Berechtigungen. Regular besitzt nur ausdrücklich ausgewählte Berechtigungen.
- JavaScript, normale DOM-Aktionen, nativer Klick, jede native Tastaturoperation, Netzwerkzugriff und expliziter `debugger`-Zugriff sind parallele Berechtigungen; eine gewährt nicht stillschweigend die andere.
- Befehle desselben Keys werden in der aktuellen Erweiterungslaufzeit serialisiert. Verschiedene Keys haben unabhängige Lanes, ihre Effekte auf derselben Webseite können aber konkurrieren.
- Eine Belegung gehört einem Key. Es gibt kein verborgenes takeover, force oder replace: zuerst release, danach acquire.
- Der vollständige Key bleibt in der Erweiterung. Die vertrauenswürdige Verwaltungsseite und Aufrufer mit gesonderter Berechtigung für `keys.create` oder `keys.reveal` können ihn erhalten; normale Listen und Diagnosen enthalten ihn nicht. Die CLI liest ihn nur aus `BKA_API_KEY` oder einer ausdrücklich gewählten Umgebungsvariable.

Ein mächtiger Key ist wie ein lokaler Browser-Steuerungsnachweis zu behandeln und nur vertrauenswürdigen Agenten oder Automatisierungen zu geben. Technische Key-Berechtigungen ersetzen niemals die Zustimmung des Benutzers zu Zahlungen, Veröffentlichungen, Nachrichten, Kontenänderungen, Löschungen oder anderen folgenreichen Aktionen.

## Browser- und Plattformgrenzen

Chromium kontrolliert weiterhin host access, eingeschränkte Seiten, file-URL-Zugriff, **Allow User Scripts**, Aktivierung der Erweiterung und jede DevTools-Debugging-Bestätigung. Root kann diese browserseitigen Grenzen nicht umgehen.

Windows- und Linux-App bieten beide Routing und Dateiablage. Windows kündigt zusätzlich die aktuellen nativen Klick- und Tastatur-Backends an, Linux noch nicht. Inkognito-Modus und Chromium-Derivate müssen mit ihrem jeweiligen Profil und ihren Richtlinien geprüft werden.

Agent-Einrichtung: [Browser Key Automation skill](skills/browser-key-automation/SKILL.md).

Dieses Projekt wird vom Autor gepflegt. Externe Beiträge und Pull Requests werden nicht angenommen.
