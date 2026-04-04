# Toudou — Drag & Drop

## Comportement

Le panneau Toudous supporte le drag & drop via l'API `TreeDragAndDropController`.

### Réordonnement de todos

- Une todo peut être déplacée **au sein de sa catégorie** pour changer son ordre.
- Une todo peut être déplacée **vers une autre catégorie** (drop sur la catégorie cible ou entre des todos d'une autre catégorie).
- Une todo catégorisée peut être déplacée **vers le niveau racine** (drop sur le fond du TreeView ou entre des todos sans catégorie) → elle perd sa catégorie.
- Une todo sans catégorie peut être déplacée **vers une catégorie** (drop sur la catégorie).

### Réordonnement de catégories

- Les catégories peuvent être réordonnées par drag & drop.

### Règles

- On ne peut pas drop une catégorie dans une autre catégorie.
- On ne peut pas drag depuis/vers le panneau Toudones.
- Le `order` de tous les éléments affectés est recalculé après un drop.
- Le fichier JSON est sauvegardé immédiatement après chaque opération.

### MIME type

Utiliser `application/vnd.code.tree.toudouView` comme type de drag pour le TreeView.
