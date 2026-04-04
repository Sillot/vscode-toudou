# Toudou — Modèle de données

## Stockage

- Fichier JSON unique : `toudou-{workspacename}.json` dans `context.storageUri` (workspaceStorage) par défaut
- Chemin personnalisable via les settings `toudou.storagePath` (par workspace) et `toudou.defaultStoragePath` (global)
- Le placeholder `{workspace}` dans le chemin est remplacé par le nom du workspace en minuscules
- Jamais dans le repo, jamais commité
- VS Code gère le cycle de vie du dossier
- Le fichier est validé au chargement : les clés dangereuses (`__proto__`, `constructor`, `prototype`) sont rejetées et la structure est reconstruite explicitement

## Schéma

### Category

| Champ   | Type               | Description                          |
|---------|--------------------|--------------------------------------|
| `id`    | `string`           | UUID v4                              |
| `name`  | `string`           | Nom affiché                          |
| `order` | `number`           | Position dans la liste (0-indexed)   |
| `emoji` | `string \| undefined` | Emoji optionnel affiché devant le nom |

- Pas de catégorie par défaut. Les todos sans catégorie apparaissent en haut du TreeView.
- Toutes les catégories peuvent être renommées et supprimées.

### Todo

| Champ         | Type                     | Description                              |
|---------------|--------------------------|------------------------------------------|
| `id`          | `string`                 | UUID v4                                  |
| `title`       | `string`                 | Titre de la todo                         |
| `description` | `string \| undefined`    | Description optionnelle                  |
| `categoryId`  | `string \| undefined`    | Référence vers la catégorie (undefined = sans catégorie) |
| `priority`    | `TodoPriority \| undefined` | Priorité optionnelle                  |
| `inProgress`  | `boolean \| undefined`   | Marque la todo comme "en cours" (activé via Open in Copilot) |
| `order`       | `number`                 | Position dans la liste (0-indexed)       |
| `createdAt`   | `string`                 | ISO 8601 timestamp                       |

### CompletedTodo

| Champ         | Type                     | Description                              |
|---------------|--------------------------|------------------------------------------|
| `id`          | `string`                 | UUID v4 (conservé de la todo originale)  |
| `title`       | `string`                 | Titre                                    |
| `description` | `string \| undefined`    | Description optionnelle                  |
| `categoryId`  | `string \| undefined`    | Catégorie d'origine (undefined si sans catégorie) |
| `priority`    | `TodoPriority \| undefined` | Priorité d'origine                    |
| `createdAt`   | `string`                 | Date de création originale               |
| `completedAt` | `string`                 | ISO 8601 timestamp de la complétion      |

### TodoPriority

Type union : `'high' | 'medium' | 'low'`

### Constantes

| Constante           | Valeur                              | Description                              |
|---------------------|-------------------------------------|------------------------------------------|
| `PRIORITY_ORDER`    | `{ high: 0, medium: 1, low: 2 }`   | Ordre de tri par priorité                |
| `NO_PRIORITY_ORDER` | `3`                                 | Ordre de tri pour les todos sans priorité |

### SortMode

Type union : `'manual' | 'priority' | 'category' | 'categoryPriority'`

- `manual` : tri par `order` (drag & drop)
- `priority` : liste plate triée par priorité
- `category` : groupement par catégorie, tri par `order`
- `categoryPriority` : groupement par catégorie, tri par priorité

### Fichier JSON — Structure racine

```json
{
  "categories": [],
  "todos": [],
  "history": [],
  "sortMode": "manual"
}
```

`sortMode` est optionnel (défaut : `"manual"`).
