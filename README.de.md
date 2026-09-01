# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Deutsch | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation ermöglicht einem vertrauenswürdigen Agenten oder Automatisierungsprogramm, einen autorisierten lokalen Chromium-Browser über eine Manifest-V3-Erweiterung und einen API Key zu bedienen.

Die Erweiterung besitzt Key-Authentifizierung, Berechtigungen, Browser-Referenzen, Belegungen und Browser-Operationen. Die kleine Zig-Begleit-App stellt nur lokales Routing, von der App vergebene Browser-Instance-Referenzen, Dateiablage und ausdrücklich angekündigte native Fähigkeiten bereit.

> Entwicklungsstand: Der aktuelle entpackte Entwicklungs-Build ist für Chrome/Chromium ab Version 138 vorgesehen. Er ist keine Veröffentlichung im Chrome Web Store.

Ein separates ZIP für den ersten Upload kann den Web-Store-Eintrag anlegen, darf aber erst veröffentlicht werden, nachdem Dashboard-public-key, Erweiterungs-ID und Origin-Prüfung der lokalen App synchronisiert wurden. Siehe [Chrome-Web-Store-Auslieferungsvertrag](docs/implementation/chrome-web-store-delivery.md).

## Funktionen

- Root- und Regular-Keys in einer lokalen Verwaltungsseite erstellen, erneut anzeigen, kopieren, aktualisieren, deaktivieren und widerrufen. Ein gespeicherter vollständiger Key kann später erneut angezeigt werden.
- Tabs auflisten und laufzeitgebundene `TabRef`-, `DocumentRef`-, `NodeRef`-, `TreeRef`- und `ArtifactRef`-Werte statt roher Browser-IDs verwenden.
- Einen zwischengespeicherten Seiten-Operationsbaum erkunden. Der Aufklappzustand gehört zum jeweiligen Key und bleibt beim Seitenwechsel erhalten, bis das Dokument neu geladen oder ersetzt wird.
- Knoten finden, ohne den Baum aufzuklappen, und einmalige Ansichten nach Tiefe, Geschwisterbereich oder Teilbaum abrufen; begrenztes Live-DOM lesen, Knoten beschreiben und DOM-Aktionen ausführen.
- JavaScript in einer ausdrücklich gewählten `USER_SCRIPT`- oder `MAIN`-World ausführen, wenn Chromium **Allow User Scripts** aktiviert hat.
- Auf Navigation, `interactive`, `complete`, DOM- oder Textbedingungen warten.
- Die aktuelle Seite als MHTML speichern, ein verifiziertes Viewport-Bild erfassen, begrenzte Artifacts übertragen und eigenständige HTML-Demos ohne lokalen HTTP-Server öffnen.
- Mit `dom.click.real` einen ausdrücklichen nativen Windows-Linksklick senden. Die Berechtigung ist von normalem `dom.click` unabhängig.
- Einen Tab oder den globalen Bereich durch einen Key belegen. Ein anderer berechtigter Key muss die Belegung ausdrücklich freigeben, bevor er sie selbst erwirbt.

Die Command Registry ist die maßgebliche Quelle für exakte Methoden, Schemas, Berechtigungen und Fehler. `system.describe` meldet den aktiven Build und die effektiven Berechtigungen des aufrufenden Keys.

## Architektur

```text
Agent / Automatisierung
        |
        | BKA_API_KEY + command
        v
Windows- oder Linux-Zig-Begleit-App
        |
        | lokale loopback route + App-vergebene InstanceRef
        v
MV3 offscreen transport
        |
        v
Service Worker der Erweiterung
        |
        +-- Key-Authentifizierung und Berechtigungen
        +-- Belegungen und Laufzeitreferenzen
        +-- Tabs, Seitenbaum, DOM, JavaScript und Artifacts
        `-- optionale Plattformfähigkeits-Anfrage
```

Die Erweiterung ist die einzige Besitzerin des Geschäftszustands. Die Begleit-App speichert keine Key-Datenbank und entscheidet nicht über Browser-Berechtigungen. Jede erfolgreich verbundene Erweiterung erhält ihre Instance-Referenz von der App; die Erweiterung erzeugt oder speichert keine eigene Instanznummer.

Der Hauptpfad verwendet normale Erweiterungsberechtigungen. CDP/DevTools können als getrennte optionale Fähigkeit bestehen bleiben, aber die eigene Debugging-Bestätigung von Chromium kann dieses Projekt nicht entfernen.

## Schnellstart

### Voraussetzungen

- Chrome oder ein kompatibler Chromium-Browser ab Version 138
- Windows x86_64 oder Linux x86_64 für die Begleit-App
- Node.js 20 oder neuer für die mitgelieferte CLI
- Zig nur zum Erstellen der App aus dem Quellcode

### 1. Getrennte Pakete erstellen

```text
npm ci
npm run build:dev-package
```

Der Build erzeugt drei unabhängige Archive:

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

Erweiterung und lokale App werden bewusst getrennt ausgeliefert. Jedes Archiv enthält eine eigene `START-HERE.md` und `SHA256SUMS.txt`.

### 2. Erweiterung laden

1. Das Erweiterungsarchiv vollständig entpacken.
2. `chrome://extensions` öffnen, den Entwicklermodus aktivieren und **Entpackte Erweiterung laden** wählen.
3. Das entpackte Verzeichnis wählen, in dessen Wurzel direkt `manifest.json` liegt.
4. Auf der Detailseite **Allow User Scripts** aktivieren und die Erweiterung neu laden. Dieser vom Browser verwaltete Schalter ist nur für `js.execute` erforderlich; Key-Verwaltung, DOM und Seitenbaum funktionieren auch ohne ihn.
5. **Browser Key Automation** über die Symbolleiste öffnen. Für vollständig vertrauenswürdige Kontrolle einen Root Key, für einen begrenzten Umfang einen Regular Key mit den benötigten Berechtigungen erstellen.

Bei der ersten Installation öffnet sich eine lokale Einrichtungsseite. Updates und erneutes Laden öffnen sie nicht wiederholt.

### 3. Begleit-App starten

Das passende App-Archiv entpacken und das Relay weiterlaufen lassen:

```text
# Windows
.\browser-key-relay.exe

# Linux
chmod +x ./browser-key-relay
./browser-key-relay
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

### Nativer `.real`-Klick

`dom.click.real` ist ausdrücklich und von `dom.click` unabhängig. Unter Windows fordert es Chromium auf, den Ziel-Tab zu aktivieren und sein Browserfenster zu fokussieren, prüft, ob das referenzierte Element aktuell, sichtbar, aktiviert und unverdeckt ist, und bittet dann die App um genau einen nativen Linksklick im passenden Chromium-Inhaltsfenster.

`{ "status": "input_sent" }` bedeutet nur, dass eine Eingabesequenz angenommen wurde, nicht dass die Website den gewünschten Geschäftsvorgang abgeschlossen hat. Die Seite muss anschließend beobachtet werden. Unbekannte oder fehlgeschlagene native Eingaben dürfen nie automatisch wiederholt werden. Die Linux-App kündigt `native.input.click.v1` derzeit nicht an; dort lehnt die Erweiterung `.real` vor jeder Seitenvorbereitung ab.

## Keys, Berechtigungen und Belegung

- Ein Key ist die einzige externe Identität. Agent-Marke, Prozess, Konto, Socket und App-Instance sind keine zusätzlichen Autorisierungsidentitäten.
- Root besitzt dynamisch alle aktiven Berechtigungen. Regular besitzt nur ausdrücklich ausgewählte Berechtigungen.
- JavaScript, normale DOM-Aktionen, native `.real`-Eingabe, Netzwerkzugriff und künftige Debugging-Backends sind parallele Berechtigungen; eine gewährt nicht stillschweigend die andere.
- Befehle desselben Keys werden in der aktuellen Erweiterungslaufzeit serialisiert. Verschiedene Keys haben unabhängige Lanes, ihre Effekte auf derselben Webseite können aber konkurrieren.
- Eine Belegung gehört einem Key. Es gibt kein verborgenes takeover, force oder replace: zuerst release, danach acquire.
- Der vollständige Key bleibt in der Erweiterung. Die vertrauenswürdige Verwaltungsseite und Aufrufer mit gesonderter Berechtigung für `keys.create` oder `keys.reveal` können ihn erhalten; normale Listen und Diagnosen enthalten ihn nicht. Die CLI liest ihn nur aus `BKA_API_KEY` oder einer ausdrücklich gewählten Umgebungsvariable.

Ein mächtiger Key ist wie ein lokaler Browser-Steuerungsnachweis zu behandeln und nur vertrauenswürdigen Agenten oder Automatisierungen zu geben. Technische Key-Berechtigungen ersetzen niemals die Zustimmung des Benutzers zu Zahlungen, Veröffentlichungen, Nachrichten, Kontenänderungen, Löschungen oder anderen folgenreichen Aktionen.

## Browser- und Plattformgrenzen

Chromium kontrolliert weiterhin host access, eingeschränkte Seiten, file-URL-Zugriff, **Allow User Scripts**, Aktivierung der Erweiterung und jede DevTools-Debugging-Bestätigung. Root kann diese browserseitigen Grenzen nicht umgehen.

Windows- und Linux-App bieten beide Routing und Dateiablage. Windows kündigt zusätzlich das aktuelle native Klick-Backend an, Linux noch nicht. Inkognito-Modus und Chromium-Derivate müssen mit ihrem jeweiligen Profil und ihren Richtlinien geprüft werden.

## Entwicklung

| Befehl | Zweck |
|---|---|
| `npm run generate` | Projektionen für Commands, UI, Transport, Capabilities und Freedom Points erzeugen |
| `npm run check:extension` | Neu erzeugen und alle Erweiterungs-Realms typprüfen |
| `npm run build` | Erweiterung und Zig-App für die aktuelle Plattform erstellen |
| `npm run test:unit` | UI-, Key-, Runtime-, WebSocket- und Zig-Unit-Tests |
| `npm run test:runtime` | Unit-Tests plus isolierte Relay/Chromium-Integration |
| `npm run build:dev-package` | Erweiterung und App-Pakete für beide Plattformen erstellen |
| `npm run build:chrome-web-store:first-upload` | Identitäts-Bootstrap-ZIP nur zum Anlegen des Web-Store-Eintrags erstellen |
| `npm run test:dev-package-smoke` | Archivstruktur, Programme, Hashes und Skill-Referenzen prüfen |

Isolierte Integrationstests verwenden temporäre Ports, Profile und Relay-Prozesse. Sie dürfen nicht auf ein persönliches Browserprofil oder eine vorhandene persönliche App-Instance zeigen.

## Dokumentation

- [Dokumentationsindex](docs/README.md)
- [Aktuelle Entscheidungen](docs/decisions.md)
- [Fortschritt und verifizierter Stand](docs/PROGRESS.md)
- [Command-Vertrag](docs/contracts/commands.md)
- [Seiten-Operationsbaum](docs/design/page-information-tree.md)
- [Freedom Points](docs/design/freedom-points.md)
- [Auslieferungsstruktur](docs/design/delivery-layout.md)
- [Agent-Skill](skills/browser-key-automation/SKILL.md)

Frühere Cleaner/PageIR-Entwürfe liegen ausschließlich unter `docs/historical/` und beschreiben nicht das aktuelle Produktverhalten.
