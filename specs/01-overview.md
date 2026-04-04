# Toudou — Vue d'ensemble

## Pitch

Extension VS Code de gestion de todos, scopée au workspace. Simple, locale, persistante entre les sessions, avec un panneau des tâches complétées (Toudones) et intégration IA.

## Principes directeurs

- **Simple** : pas d'usine à gaz, UX minimaliste, zéro configuration requise
- **Local** : aucune trace dans le repo, données stockées dans le `workspaceStorage` de VS Code
- **Persistant** : les données survivent entre les sessions (fermer/rouvrir VS Code)
- **Scopé** : chaque workspace a sa propre liste de todos, totalement indépendante

## Stack technique

- TypeScript
- API VS Code (TreeView, commandes, workspaceStorage)
- Build : esbuild
- Stockage : fichier JSON unique dans `context.storageUri`

## Structure de l'extension

```
src/
  extension.ts          — Point d'entrée, activation, registration des commandes
  models/
    todo.ts             — Modèle Todo
    category.ts         — Modèle Category
  providers/
    todoProvider.ts     — TreeDataProvider pour le panneau Toudous
    historyProvider.ts  — TreeDataProvider pour le panneau Toudones
  services/
    storageService.ts   — Lecture/écriture du fichier JSON
  tools/
    todoTools.ts        — Language model tools pour l'intégration IA
```
