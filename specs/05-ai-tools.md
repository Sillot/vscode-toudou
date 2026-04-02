# Toudou — Intégration IA (Language Model Tools)

## Principe

L'extension expose des **Language Model Tools** (API `vscode.lm.registerTool`) que les agents IA (Copilot Chat, etc.) peuvent appeler via des commandes naturelles comme "rajoute ça en todo".

## Tools exposés

### `toudou_createTodo`

Crée une nouvelle todo.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `title` | `string` | ✅ | Titre de la todo |
| `category` | `string` | ❌ | Nom de la catégorie (créée si inexistante, défaut : sans catégorie) |
| `description` | `string` | ❌ | Description optionnelle |

**Retour :** confirmation avec l'id de la todo créée.

### `toudou_listTodos`

Liste les todos actives.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `category` | `string` | ❌ | Filtrer par nom de catégorie |

**Retour :** liste des todos avec id, titre, catégorie, description.

### `toudou_completeTodo`

Marque une todo comme complétée.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | `string` | ✅* | ID de la todo |
| `title` | `string` | ✅* | Ou titre exact (recherche fuzzy) |

*Un des deux est requis.

**Retour :** confirmation.

### `toudou_deleteTodo`

Supprime définitivement une todo.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `id` | `string` | ✅* | ID de la todo |
| `title` | `string` | ✅* | Ou titre exact (recherche fuzzy) |

*Un des deux est requis.

**Retour :** confirmation.

### `toudou_createCategory`

Crée une nouvelle catégorie.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | `string` | ✅ | Nom de la catégorie |

**Retour :** confirmation avec l'id de la catégorie créée.

### `toudou_renameCategory`

Renomme une catégorie existante.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `name` | `string` | ✅ | Nom actuel de la catégorie |
| `newName` | `string` | ✅ | Nouveau nom |

**Retour :** confirmation.

## Comportement attendu

- Si l'agent demande de créer une todo dans une catégorie inexistante, la catégorie est créée automatiquement.
- Si aucune catégorie n'est spécifiée, la todo est créée sans catégorie (en haut du TreeView).
- La recherche par titre est insensible à la casse et tolère des différences mineures (fuzzy matching basique).
- Toutes les opérations rafraîchissent la TreeView automatiquement.
- Les tools ne demandent pas de confirmation utilisateur (l'agent est responsable de la validation).
