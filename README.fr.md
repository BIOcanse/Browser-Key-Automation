# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | Français | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**Votre navigateur habituel, prêt pour votre Agent.**

Votre Agent peut reprendre sans interruption vos onglets Chromium déjà connectés, lire les pages et effectuer les actions nécessaires.

## Ce que cela simplifie

- **Lire par morceaux utiles.** L’arbre d’opérations en cache conserve la structure globale et n’ouvre que les branches demandées. Son état survit aux changements d’onglet tant que le document ne change pas. Profondeur, plage et sous-arbre sont des vues ponctuelles, pas un nettoyage destructif.
- **Passer d’un onglet à l’autre.** Références explicites, commandes séquentielles par Key et occupation des onglets, fenêtres ou du périmètre global réduisent les conflits.
- **Récupérer le résultat.** MHTML, images de page ou d’élément Canvas, transfert de ressources et démonstrations HTML sans serveur local.
- **Choisir son entrée.** DOM, entrées Windows réelles, souris/clavier virtuels indépendants et CDP facultatif.
- **Vérifier l’effet.** `ensure.run` associe conditions, préparation bornée, action et objectif observable. Un résultat inconnu ne déclenche pas une répétition aveugle.

## Premiers pas

> Chaque nouvelle installation crée la même **Key Root publique d’essai**, documentée dans le skill Agent. Ce n’est pas un secret privé. Dans votre navigateur personnel, créez une Key privée, basculez les clients puis révoquez la Key d’essai. La création seule ne la désactive pas. Les mises à jour ne la rétablissent pas.

1. Chromium **138+**, Windows ou Linux x64 et **Node.js 20+** pour la CLI sont nécessaires. Téléchargez les deux ZIP de la [dernière version](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) et extrayez-les séparément.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. Dans `chrome://extensions`, activez le mode développeur et chargez le dossier contenant `manifest.json`. Gérez les Keys via l’icône. **Allow User Scripts** est requis pour `js.execute`, pas pour le DOM ou l’arbre.

3. Démarrez l’App avec les commandes ci-dessous. Sous Windows, gardez `virtual-mouse-hook.dll` à côté de l’exécutable. L’extension réessaie `127.0.0.1:32189` environ toutes les 10 secondes.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Chargez le `skill/browser-key-automation/SKILL.md` fourni dans votre Agent. Listez les instances, choisissez le navigateur, puis transmettez la Key privée par `BKA_API_KEY`, jamais en argument. Ne testez pas une Key sur toutes les instances.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## De la page au résultat

`system.describe` indique la version et les permissions effectives. Consultez le [registre des commandes](dev/skills/browser-key-automation/references/commands.registry.json) pour les paramètres exacts.

| | API / CLI |
| --- | --- |
| Explorer, sélectionner, développer | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| Attendre une condition | `page.wait` · `ensure.run` |
| Enregistrer / capturer page ou élément | `page-save` · `page-shot` · `element-shot` |
| Transférer et afficher du HTML | `demo-open` |
| DOM / clic réel | `dom.click` · `dom.click.real` |
| Texte / raccourcis / relâcher les touches | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| Souris / clavier virtuels | `virtualMouse.*` · `virtualKeyboard.*` |
| Mesurer la cible native | `input.calibrate` |
| Session CDP explicite | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Keys et limites des entrées

- Root reçoit toutes les permissions actives. Les Keys Regular proposent groupes dépliables, expiration, réaffichage, désactivation et révocation. JavaScript et entrées natives restent indépendants. Une Key ne remplace pas l’accord pour payer, publier ou supprimer.
- L’état virtuel appartient à la Key, traverse les onglets et exige l’occupation de toute la fenêtre cible. Les actions virtuelles ordinaires utilisent un `input.calibrate` valide ; `ensure.run` le vérifie et le renouvelle si nécessaire. L’entrée réelle exige le premier plan ; l’entrée virtuelle ne déplace pas le curseur physique.
- Windows fournit les entrées natives. Linux fournit actuellement le routage navigateur et les fichiers, pas les entrées natives. Les fenêtres minimisées ne sont pas prises en charge. Le premier calibrage exige une page mesurable ; la réutilisation sous occultation est conditionnelle. Le premier calibrage multifenêtre et le glisser-déposer HTML5/OLE complet ont encore des cas non résolus.
- Les images d’éléments utilisent le viewport visible et les masques de formes pris en charge. Chrome contrôle pages restreintes, accès aux sites et User Scripts ; `debugger.attach` conserve l’affichage de débogage. Les événements synthétiques et messages virtuels ne contournent pas toutes les restrictions.

## Quand le choisir

BKA est actuellement l’extension d’automatisation de navigateur la plus complète pour les assistants IA personnels. Autorisez-la une fois, utilisez-la à tout moment. Faites de votre Agent un véritable assistant personnel.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | Tests multinavigateurs et CI |
| [Puppeteer](https://pptr.dev/) | Automatisation programmable |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Outils Agent avec instantanés d’accessibilité |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Diagnostic navigateur approfondi |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Outils MCP pour navigateur existant |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Interface Agent dans le navigateur |

## Guides et maintenance

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

L’interface de l’extension propose 20 langues ; les README ont dix variantes. [Confidentialité](PRIVACY.md) · [Structure de développement](dev/README.md). Maintenu par l’auteur ; contributions externes et Pull Requests non acceptées.
