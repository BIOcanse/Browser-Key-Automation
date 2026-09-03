# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | Français | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation transforme le navigateur Chromium que vous utilisez déjà en surface d'automatisation délimitée par Key pour des Agents et programmes de confiance. Après une installation et la création d'une Key, un client autorisé peut travailler entre vos onglets déjà connectés sans lancer un navigateur d'automatisation séparé.

Le chemin principal utilise les API ordinaires d'extension, et non CDP, WebDriver, des options remote-debugging ou `chrome.debugger`. Chromium continue de gérer l'installation, l'accès aux sites et le réglage unique **Allow User Scripts**. Après cette configuration, les commandes courantes n'attachent pas de débogueur et n'affichent ni confirmation de connexion de débogage ni barre d'avertissement de Chrome.

## Pourquoi Browser Key Automation ?

- **Contrôle transparent du navigateur déjà devant vous.** Lister, créer, sélectionner, naviguer, recharger et fermer des onglets à tout moment, tout en conservant les sessions, cookies, extensions et états de page atteints manuellement.
- **Toute la page dans une vue adaptée à l'Agent.** L'arbre d'opérations canonical mis en cache garde la structure globale visible, ne développe que les branches demandées et conserve l'état de chaque Key jusqu'au changement de document. Les vues ponctuelles par profondeur, plage ou sous-arbre ne modifient pas cet état.
- **Une confiance délimitée par Key plutôt qu'un endpoint de débogage ouvert.** Les Keys Root et Regular ont des permissions, une expiration, une nouvelle révélation, une désactivation et une révocation explicites. Les appels d'une même Key sont sérialisés ; des Keys différentes travaillent indépendamment.
- **Un clic natif avec un seul suffixe.** Sous Windows, `dom.click.real` combine la géométrie d'élément observée par l'extension avec l'App locale pour envoyer un clic gauche au niveau OS lorsqu'une page refuse l'activation DOM synthétique. La cible doit rester présente, visible, active et non masquée.
- **Les fichiers sont de première classe.** Enregistrer une page en MHTML, capturer le viewport visible, récupérer des ressources comme Artifacts bornés et les écrire sur disque, téléverser du HTML autonome et l'ouvrir comme démonstration sans serveur Web local.
- **Coordination de plusieurs clients de confiance.** Une Key peut occuper un onglet ou la portée globale pour éviter un état incohérent ; une autre Key autorisée doit libérer explicitement cette occupation avant de l'acquérir.

### Comparaison des flux de travail

Modèles de connexion vérifiés le 2026-09-01. La comparaison porte sur les parcours habituels, pas sur les plafonds théoriques de fonctions.

| Approche | Chromium existant et connecté | Chemin de contrôle habituel | Meilleur usage |
| --- | --- | --- | --- |
| **Browser Key Automation** | Oui, sur tout onglet autorisé | API ordinaires d'extension + authentification Key ; l'App locale ajoute routage, fichiers et clic `.real` facultatif | Accès Agent durable sans attachement d'un débogueur, arbre de cache sélectif et flux de fichiers intégrés |
| [Playwright](https://playwright.dev/docs/api/class-browsertype), [Puppeteer](https://pptr.dev/guides/browser-management), [Selenium](https://www.selenium.dev/documentation/overview/) | Le parcours habituel crée une session d'automatisation ; la connexion à un Chromium existant est aussi possible | Playwright/CDP, Puppeteer/CDP ou WebDriver | Tests déterministes, validation multi-navigateurs, CI et écosystèmes matures de locators et de débogage |
| [Extension Playwright MCP](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | Oui ; un token de profil peut supprimer sa propre approbation ultérieure | Playwright relayé par une extension qui déclare la permission Chrome `debugger` | Actions Playwright et accessibility snapshots sur des onglets existants sélectionnés |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | Oui, après activation du remote debugging ou exposition d'un endpoint de débogage | DevTools/CDP ; l'auto-connect de Chrome demande l'autorisation pour chaque session de débogage | Diagnostic profond Console, Network, Performance, mémoire et autres DevTools |
| [Browser MCP](https://browsermcp.io/) | Oui, après connexion de l'onglet courant par l'utilisateur | Extension + MCP local, limité à l'onglet de travail explicitement connecté | Une surface MCP compacte pour un onglet existant choisi |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Oui, entre les onglets | Extension + native-messaging bridge ; le manifest demande `debugger` en plus des permissions ordinaires | Outils MCP étendus entre onglets, capture réseau, téléchargements et téléversement de fichiers |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Oui | Agent intégré au navigateur sur Puppeteer/CDP, avec Keys de LLM provider fournies par l'utilisateur | Une UI multi-Agent intégrée plutôt qu'un plan de contrôle indépendant du provider |

Browser Key Automation ne remplace ni les suites de tests Playwright/Selenium ni les diagnostics DevTools approfondis. Il occupe un autre rôle : contrôler avec peu de friction et des permissions explicites le navigateur qu'une personne utilise déjà, avec une structure claire et des fichiers suffisants pour les tâches pratiques d'un Agent.

> Distribution : [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) fournit une extension unpacked pour Chrome/Chromium 138 ou version ultérieure et une App locale distincte. La publication sur le Chrome Web Store suit une procédure séparée. Chaque Release comporte exactement deux téléchargements : `browser-key-automation-extension-v0.0.0.3.zip` et `browser-key-automation-local-app-v0.0.0.3.zip`.

## Fonctionnalités

- Créer, révéler à nouveau, copier, mettre à jour, désactiver et révoquer des Keys Root ou Regular dans une page d'administration locale. Une Key complète enregistrée reste consultable ultérieurement.
- Lister les onglets et utiliser des valeurs `TabRef`, `DocumentRef`, `NodeRef`, `TreeRef` et `ArtifactRef` liées au runtime, plutôt que des identifiants bruts du navigateur.
- Explorer un arbre d'opérations de page mis en cache. L'état d'expansion appartient à chaque Key et subsiste lorsque l'on quitte puis retrouve la page, jusqu'au rechargement ou remplacement du document.
- Trouver des nœuds sans développer l'arbre, demander des vues ponctuelles par profondeur, plage de frères ou sous-arbre, lire un live DOM borné, décrire les nœuds et exécuter des actions DOM.
- Exécuter JavaScript dans un world `USER_SCRIPT` ou `MAIN` explicite lorsque **Allow User Scripts** est activé dans Chromium.
- Attendre la navigation, `interactive`, `complete`, une condition DOM ou une condition de texte.
- Enregistrer la page actuelle en MHTML, capturer une image vérifiée du viewport, transférer des Artifacts bornés et ouvrir des démonstrations HTML autonomes sans serveur HTTP local.
- Envoyer un clic gauche natif Windows explicite avec `dom.click.real`, dont la permission est indépendante de `dom.click`.
- Permettre à une Key d'occuper un onglet ou la portée globale. Une autre Key autorisée doit libérer explicitement l'occupation avant de l'acquérir.

La Command Registry est la source de vérité pour les méthodes, schemas, permissions et erreurs exacts. `system.describe` renvoie le build actif et les permissions effectives de la Key appelante.

## Démarrage rapide

### Prérequis

- Chrome ou un navigateur Chromium compatible, version 138 ou ultérieure
- App compagnon Windows x86_64 ou Linux x86_64
- Node.js 20 ou ultérieur pour la CLI fournie

### 1. Télécharger l'extension et l'App

Téléchargez les deux ZIP de la [dernière Release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest), puis extrayez chacun dans un dossier distinct.

- Extension: `browser-key-automation-extension-v0.0.0.3.zip`
- App locale: `browser-key-automation-local-app-v0.0.0.3.zip`

Le ZIP de l'App contient `windows-x86_64/` et `linux-x86_64/`, ainsi que la CLI et le skill Agent. Aucune compilation des sources n'est nécessaire.

### 2. Charger l'extension

1. Extraire complètement l'archive de l'extension.
2. Ouvrir `chrome://extensions`, activer le mode développeur et choisir **Charger l'extension non empaquetée**.
3. Sélectionner le dossier extrait dont la racine contient directement `manifest.json`.
4. Dans les détails de l'extension, activer **Allow User Scripts**, puis recharger l'extension. Ce réglage appartenant au navigateur n'est requis que pour `js.execute` ; la gestion des Keys, le DOM et l'arbre de page restent utilisables sans lui.
5. Ouvrir **Browser Key Automation** depuis la barre d'outils. Créer une Root Key pour un contrôle totalement fiable, ou une Regular Key limitée aux permissions nécessaires.

La première installation ouvre une page locale de configuration. Les mises à jour et rechargements ne la rouvrent pas en boucle.

### 3. Démarrer l'App compagnon

Extraire l'archive App de GitHub Release et laisser actif le relay de la plateforme courante :

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

L'endpoint par défaut est `127.0.0.1:32189`. Si l'App est indisponible, l'extension réessaie selon l'intervalle nominal configuré de 10 secondes jusqu'à la connexion. Ne pas démarrer une seconde App si une instance compatible possède déjà cet endpoint fixe.

### 4. Connecter la CLI

Depuis le dossier extrait de l'App locale :

```text
node client/browser-key-cli.mjs instances
```

Cette commande ne requiert aucune Key. Zéro instance signifie qu'aucune extension n'est encore connectée. S'il y en a plusieurs, sélectionner explicitement une `relayEpoch/instanceNumber` actuelle ; ne jamais essayer une bearer Key sur toutes les instances.

Fournir la Key par variable d'environnement, jamais dans argv :

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

La CLI réénumère les instances avant de lire la Key. Si delivery vaut `unknown`, le résultat est réellement inconnu : ne pas réessayer automatiquement une commande à effet.

## Flux courants

- Découverte de page : `tabs.list` → `page.tree.open` → `page.tree.find` ou `page.tree.expand.v2` → `page.tree.view.get`
- Synchronisation : `page.wait` ; sans timeout, la valeur est de 10 secondes, et une condition déjà satisfaite revient immédiatement.
- Enregistrer une page : `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`
- Capturer le viewport : `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`
- Ouvrir une démo : `node client/browser-key-cli.mjs demo-open ./demo.html`
- Avant d'utiliser une commande inconnue, consulter `skills/browser-key-automation/references/commands.registry.json`. Le skill Agent fourni contient les mêmes références générées.

### Images d'éléments et débogage explicite

`page.screenshot.element` permet à un Agent d'inspecter un Canvas, un graphique ou un conteneur avec sa NodeRef existante. Les enfants visibles sont inclus, les formes prises en charge sont masquées, puis l'ensemble est centré à proportions constantes dans un PNG transparent de dimensions exactes. Aucun calcul de coordonnées d'écran ni attachement de débogueur n'est nécessaire.

```text
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
```

Pour un diagnostic approfondi : `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach`. La permission indépendante `debugger` donne accès aux commandes et événements CDP ; la confirmation et l'avertissement de débogage propres à Chrome restent présents. Les opérations ordinaires conservent leur chemin habituel.

La capture d'élément utilise seulement le viewport actuel d'un onglet déjà actif, sans défilement automatique ni reconstruction de contenu caché. Les formes prises en charge, la portée du document principal, les régions locales, les grands résultats CDP et les erreurs sont décrits dans [le guide Agent](skills/browser-key-automation/references/debugger-and-element-capture.md).

### Clic natif `.real`

`dom.click.real` est explicite et indépendant de `dom.click`. Sous Windows, il demande à Chromium d'activer l'onglet cible et de focaliser sa fenêtre, vérifie que l'élément référencé est toujours présent, visible, actif et non masqué, puis demande à l'App d'envoyer un unique clic gauche natif à la fenêtre de contenu Chromium correspondante.

`{ "status": "input_sent" }` signifie uniquement qu'une séquence d'entrée a été acceptée, pas que le site a terminé l'action métier. Observer ensuite la page. Ne jamais rejouer automatiquement une entrée native inconnue ou échouée. L'App Linux n'annonce actuellement pas `native.input.click.v1` ; l'extension y refuse donc `.real` avant toute préparation de page.

## Keys, permissions et occupations

- La Key est l'unique identité externe. La marque de l'Agent, le processus, le compte, le socket et l'Instance de l'App ne sont pas des identités d'autorisation supplémentaires.
- Root reçoit dynamiquement toutes les permissions actives. Regular ne reçoit que les permissions sélectionnées explicitement.
- JavaScript, les actions DOM ordinaires, l'entrée native `.real`, l'accès réseau et l'accès explicite `debugger` sont des permissions parallèles ; l'une n'accorde pas silencieusement les autres.
- Les commandes d'une même Key sont sérialisées dans le runtime actuel de l'extension. Des Keys différentes ont des lanes indépendantes, mais leurs effets sur une même page peuvent entrer en concurrence.
- Une occupation appartient à une Key. Il n'existe pas de takeover, force ou replace caché : release d'abord, acquire ensuite.
- La Key complète reste dans l'extension. La page d'administration de confiance et les appelants autorisés séparément pour `keys.create` ou `keys.reveal` peuvent la recevoir ; les listes et diagnostics ordinaires ne la contiennent pas. La CLI la lit uniquement depuis `BKA_API_KEY` ou une variable d'environnement explicitement choisie.

Traitez une Key puissante comme un identifiant local de contrôle du navigateur et ne la confiez qu'à des Agents ou automatisations de confiance. Une permission technique ne remplace jamais l'autorisation de l'utilisateur pour un paiement, une publication, un message, une modification de compte, une suppression ou toute autre action lourde de conséquences.

## Limites du navigateur et des plateformes

Chromium contrôle toujours le host access, les pages restreintes, l'accès aux file URLs, **Allow User Scripts**, l'activation de l'extension et toute confirmation de débogage DevTools. Root ne contourne pas ces limites.

Les Apps Windows et Linux fournissent toutes deux le routage et l'écriture de fichiers. Windows annonce en plus le backend actuel de clic natif ; Linux ne l'annonce pas encore. Le mode navigation privée et les dérivés Chromium doivent être vérifiés avec leur propre profil et leurs propres politiques.

Configuration de l'Agent : [Browser Key Automation skill](skills/browser-key-automation/SKILL.md).

Ce projet est maintenu par son auteur. Les contributions externes et les Pull Requests ne sont pas acceptées.
