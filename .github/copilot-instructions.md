# Toudou — Instructions Copilot

## Projet

Toudou est une extension VS Code de gestion de todos scopée au workspace. Les données sont stockées localement dans `workspaceStorage`, jamais dans le repo.

## Langue

- Le code (variables, fonctions, commentaires techniques) est en **anglais**.
- Les messages utilisateur (UI, labels, commandes) sont en **anglais**.
- La communication avec le développeur est en **français**.

## Stack

- **TypeScript** strict (`"strict": true` dans tsconfig)
- **API VS Code** : TreeView, commandes, workspaceStorage, Language Model Tools
- **Build** : esbuild (bundle unique `dist/extension.js`)
- **Lint** : ESLint 9 (flat config)
- **Format** : Prettier

## Conventions de code

- Pas de classes sauf pour les providers VS Code (TreeDataProvider) où l'API l'impose.
- Préférer les fonctions et les modules.
- Types explicites aux frontières (paramètres de fonctions publiques, retours), inférés ailleurs.
- Pas de `any`. Utiliser `unknown` si nécessaire.
- Pas de barrel files (`index.ts` qui ré-exportent).
- Imports avec chemins relatifs.
- Nommage : `camelCase` pour variables/fonctions, `PascalCase` pour types/interfaces, `UPPER_SNAKE_CASE` pour constantes.

## Architecture

```
src/
  extension.ts          — Point d'entrée
  models/               — Types et interfaces
  providers/            — TreeDataProviders (TodoProvider, HistoryProvider)
  services/             — Logique métier (StorageService)
  tools/                — Language Model Tools pour l'IA
```

## Spécifications fonctionnelles

Les specs détaillées sont dans le dossier `specs/` à la racine :
- `specs/01-overview.md` — Vue d'ensemble
- `specs/02-data-model.md` — Modèle de données
- `specs/03-ui.md` — Interface utilisateur
- `specs/04-commands.md` — Commandes
- `specs/05-ai-tools.md` — Intégration IA
- `specs/06-drag-and-drop.md` — Drag & drop

**Toujours consulter les specs avant d'implémenter une fonctionnalité.**

## Docker

Toutes les commandes (build, lint, typecheck, npm) doivent être exécutées dans le container Docker `toudou-dev`, **jamais** directement sur l'hôte.

```bash
docker exec toudou-dev npm run typecheck
docker exec toudou-dev npm run lint
docker exec toudou-dev npm run compile
```

Le container est créé à partir du `Dockerfile` à la racine (image `toudou-dev`), avec le workspace monté en volume :

```bash
docker run -d --name toudou-dev \
  -v /home/quentin/Projects/vscode-extensions/vscode-toudou:/home/node/workspace \
  -w /home/node/workspace -u node toudou-dev tail -f /dev/null
```

## Règles de contribution

- Un fichier = une responsabilité.
- Tester les commandes manuellement via F5 (Extension Development Host).
- Ne jamais écrire dans le repo de l'utilisateur. Toutes les données vont dans `context.storageUri`.
- Les modifications du `package.json` (commandes, menus, vues) doivent rester synchronisées avec les specs.
- **Après toute modification de code** (ajout/suppression de commandes, types, tools, menus, etc.), proposer de lancer `/sync-specs` pour mettre à jour les specs.
