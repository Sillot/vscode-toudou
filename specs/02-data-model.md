# Toudou — Modèle de données

## Stockage

- Fichier JSON unique : `toudou.json` dans `context.storageUri` (workspaceStorage)
- Jamais dans le repo, jamais commité
- VS Code gère le cycle de vie du dossier

## Schéma

### Category

| Champ   | Type     | Description                          |
|---------|----------|--------------------------------------|
| `id`    | `string` | UUID v4                              |
| `name`  | `string` | Nom affiché                          |
| `order` | `number` | Position dans la liste (0-indexed)   |

- Pas de catégorie par défaut. Les todos sans catégorie apparaissent en haut du TreeView.
- Toutes les catégories peuvent être renommées et supprimées.

### Todo

| Champ         | Type               | Description                              |
|---------------|--------------------|------------------------------------------|
| `id`          | `string`           | UUID v4                                  |
| `title`       | `string`           | Titre de la todo                         |
| `description` | `string \| undefined` | Description optionnelle                |
| `categoryId`  | `string \| undefined` | Référence vers la catégorie (undefined = sans catégorie) |
| `order`       | `number`           | Position dans la liste (0-indexed)       |
| `createdAt`   | `string`           | ISO 8601 timestamp                       |

### CompletedTodo

| Champ         | Type               | Description                              |
|---------------|--------------------|------------------------------------------|
| `id`          | `string`           | UUID v4 (conservé de la todo originale)  |
| `title`       | `string`           | Titre                                    |
| `description` | `string \| undefined` | Description optionnelle                |
| `categoryId`  | `string \| undefined` | Catégorie d'origine (undefined si sans catégorie) |
| `createdAt`   | `string`           | Date de création originale               |
| `completedAt` | `string`           | ISO 8601 timestamp de la complétion      |

### Fichier JSON — Structure racine

```json
{
  "categories": [],
  "todos": [],
  "history": []
}
```
