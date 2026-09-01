# Browser Key Automation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | Français | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation permet à un Agent ou programme d'automatisation de confiance de piloter un navigateur Chromium local autorisé au moyen d'une extension Manifest V3 et d'une API Key.

L'extension possède l'authentification des Keys, les permissions, les références du navigateur, les occupations et les opérations du navigateur. La petite App compagnon en Zig fournit uniquement le routage local, les références d'Instance attribuées par l'App, l'écriture des fichiers et les capacités natives qu'elle annonce explicitement.

> État de développement : la version de développement unpacked actuelle cible Chrome/Chromium 138 ou version ultérieure. Ce n'est pas une publication du Chrome Web Store.

Le travail Chrome Web Store est suspendu jusqu'à la conception de l'icône définitive. Utilisez [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases) : chaque Release comporte exactement deux téléchargements, `browser-key-automation-extension-v0.0.0.1.zip` et `browser-key-automation-local-app-v0.0.0.1.zip`. Voir le [contrat de livraison GitHub Release](docs/implementation/github-release-delivery.md).

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

## Architecture

```text
Agent / automatisation
        |
        | BKA_API_KEY + command
        v
App compagnon Zig Windows ou Linux
        |
        | route loopback locale + InstanceRef attribuée par l'App
        v
MV3 offscreen transport
        |
        v
service worker de l'extension
        |
        +-- authentification et permissions des Keys
        +-- occupations et références runtime
        +-- onglets, arbre de page, DOM, JavaScript et Artifacts
        `-- demande facultative de capacité de plateforme
```

L'extension est l'unique propriétaire de l'état métier. L'App compagnon ne conserve pas de base de Keys et ne décide pas des permissions du navigateur. Chaque extension connectée reçoit sa référence d'Instance de l'App ; l'extension n'invente ni ne persiste son propre numéro.

Le chemin principal utilise les permissions ordinaires d'une extension. CDP/DevTools peut rester une capacité facultative distincte, mais ce projet ne peut pas supprimer la confirmation de débogage propre à Chromium.

## Démarrage rapide

### Prérequis

- Chrome ou un navigateur Chromium compatible, version 138 ou ultérieure
- App compagnon Windows x86_64 ou Linux x86_64
- Node.js 20 ou ultérieur pour la CLI fournie
- Zig uniquement pour compiler l'App depuis les sources

### 1. Construire les paquets séparés

```text
npm ci
npm run build:dev-package
```

La construction produit trois archives indépendantes :

- `out/browser-key-automation-extension-dev.zip`
- `out/browser-key-automation-local-app-windows-x86_64-dev.zip`
- `out/browser-key-automation-local-app-linux-x86_64-dev.zip`

L'extension et l'App locale sont volontairement distribuées séparément. Chaque archive contient son propre `START-HERE.md` et `SHA256SUMS.txt`.

`npm run build:github-release` regroupe ces intermédiaires vérifiés en deux assets GitHub : un ZIP d'extension et un ZIP d'App contenant les relais `windows-x86_64/` et `linux-x86_64/`, ainsi qu'un seul exemplaire commun de la CLI, du protocole et du skill Agent.

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

Les intermédiaires App `-dev` propres à chaque plateforme placent encore le relay à la racine de l'archive ; suivez leur `START-HERE.md` inclus.

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

### Clic natif `.real`

`dom.click.real` est explicite et indépendant de `dom.click`. Sous Windows, il demande à Chromium d'activer l'onglet cible et de focaliser sa fenêtre, vérifie que l'élément référencé est toujours présent, visible, actif et non masqué, puis demande à l'App d'envoyer un unique clic gauche natif à la fenêtre de contenu Chromium correspondante.

`{ "status": "input_sent" }` signifie uniquement qu'une séquence d'entrée a été acceptée, pas que le site a terminé l'action métier. Observer ensuite la page. Ne jamais rejouer automatiquement une entrée native inconnue ou échouée. L'App Linux n'annonce actuellement pas `native.input.click.v1` ; l'extension y refuse donc `.real` avant toute préparation de page.

## Keys, permissions et occupations

- La Key est l'unique identité externe. La marque de l'Agent, le processus, le compte, le socket et l'Instance de l'App ne sont pas des identités d'autorisation supplémentaires.
- Root reçoit dynamiquement toutes les permissions actives. Regular ne reçoit que les permissions sélectionnées explicitement.
- JavaScript, les actions DOM ordinaires, l'entrée native `.real`, l'accès réseau et les futurs backends de débogage sont des permissions parallèles ; l'une n'accorde pas silencieusement les autres.
- Les commandes d'une même Key sont sérialisées dans le runtime actuel de l'extension. Des Keys différentes ont des lanes indépendantes, mais leurs effets sur une même page peuvent entrer en concurrence.
- Une occupation appartient à une Key. Il n'existe pas de takeover, force ou replace caché : release d'abord, acquire ensuite.
- La Key complète reste dans l'extension. La page d'administration de confiance et les appelants autorisés séparément pour `keys.create` ou `keys.reveal` peuvent la recevoir ; les listes et diagnostics ordinaires ne la contiennent pas. La CLI la lit uniquement depuis `BKA_API_KEY` ou une variable d'environnement explicitement choisie.

Traitez une Key puissante comme un identifiant local de contrôle du navigateur et ne la confiez qu'à des Agents ou automatisations de confiance. Une permission technique ne remplace jamais l'autorisation de l'utilisateur pour un paiement, une publication, un message, une modification de compte, une suppression ou toute autre action lourde de conséquences.

## Limites du navigateur et des plateformes

Chromium contrôle toujours le host access, les pages restreintes, l'accès aux file URLs, **Allow User Scripts**, l'activation de l'extension et toute confirmation de débogage DevTools. Root ne contourne pas ces limites.

Les Apps Windows et Linux fournissent toutes deux le routage et l'écriture de fichiers. Windows annonce en plus le backend actuel de clic natif ; Linux ne l'annonce pas encore. Le mode navigation privée et les dérivés Chromium doivent être vérifiés avec leur propre profil et leurs propres politiques.

## Développement

| Commande | Rôle |
|---|---|
| `npm run generate` | Générer les projections de commandes, UI, transport, capacités et Freedom Points |
| `npm run check:extension` | Régénérer et vérifier les types de tous les realms de l'extension |
| `npm run build` | Construire l'extension et l'App Zig de la plateforme courante |
| `npm run test:unit` | Tests unitaires UI, Key, runtime, WebSocket et Zig |
| `npm run test:runtime` | Tests unitaires plus intégration relay/Chromium isolée |
| `npm run build:dev-package` | Construire l'extension et les Apps des deux plateformes |
| `npm run build:github-release` | Construire exactement les deux ZIP publiés dans GitHub Releases |
| `npm run build:chrome-web-store:first-upload` | Construire l'artefact d'identité suspendu ; ne pas le téléverser avant la reprise du travail sur l'icône |
| `npm run test:dev-package-smoke` | Vérifier la structure des archives, exécutables, hachages et références du skill |

Les tests d'intégration isolés utilisent des ports, profils et processus relay temporaires. Ils ne doivent jamais cibler un profil de navigateur personnel ni une Instance d'App personnelle existante.

## Documentation

- [Index de la documentation](docs/README.md)
- [Décisions actuelles](docs/decisions.md)
- [Progression et état vérifié](docs/PROGRESS.md)
- [Contrat des commandes](docs/contracts/commands.md)
- [Arbre d'opérations de page](docs/design/page-information-tree.md)
- [Freedom Points](docs/design/freedom-points.md)
- [Structure de livraison](docs/design/delivery-layout.md)
- [Skill Agent](skills/browser-key-automation/SKILL.md)

Les anciens projets Cleaner/PageIR restent uniquement sous `docs/historical/` et ne décrivent pas le comportement actuel du produit.
