# Toudou — Commandes

## Palette de commandes

Toutes les commandes sont préfixées `Toudou:`.

| Commande | ID | Description |
|----------|----|-------------|
| Toudou: Ajouter une todo | `toudou.addTodo` | Lance le flow d'ajout complet |
| Toudou: Compléter une todo | `toudou.completeTodo` | Quick pick pour choisir et compléter une todo |
| Toudou: Supprimer une todo | `toudou.deleteTodo` | Quick pick pour choisir et supprimer une todo |
| Toudou: Créer une catégorie | `toudou.addCategory` | Input box pour le nom de la catégorie |
| Toudou: Renommer une catégorie | `toudou.renameCategory` | Quick pick catégorie + input box nouveau nom |
| Toudou: Supprimer une catégorie | `toudou.deleteCategory` | Quick pick catégorie, les todos deviennent sans catégorie |
| Toudou: Restaurer depuis les Toudones | `toudou.restoreTodo` | Quick pick d'une todo complétée à restaurer |
| Toudou: Purger les Toudones | `toudou.purgeHistory` | Supprime toutes les Toudones après confirmation |
| Toudou: Changer la priorité | `toudou.changeTodoPriority` | Quick pick todo + quick pick priorité |
| Toudou: Ouvrir le fichier de stockage | `toudou.openStorageFile` | Ouvre le fichier JSON de stockage dans l'éditeur |
| Toudou: Définir le chemin de stockage | `toudou.setWorkspacePath` | Permet de choisir un chemin personnalisé pour le fichier de stockage du workspace |

## Commandes internes (non visibles dans la palette)

Ces commandes sont appelées uniquement depuis la TreeView via les menus/icônes.

| ID | Déclencheur |
|----|-------------|
| `toudou.completeTodoInline` | Icône check sur une todo |
| `toudou.deleteTodoInline` | Icône trash sur une todo |
| `toudou.editTodoTitle` | Menu contextuel "Éditer le titre" |
| `toudou.editTodoDescription` | Menu contextuel "Éditer la description" |
| `toudou.changeTodoCategory` | Menu contextuel "Changer de catégorie" |
| `toudou.changeTodoPriorityInline` | Menu contextuel "Changer la priorité" |
| `toudou.copyTodoText` | Menu contextuel "Copier le texte" (+ raccourci `Ctrl+C` / `Cmd+C` quand focus sur toudouView) |
| `toudou.openInCopilot` | Menu contextuel "Ouvrir dans Copilot" |
| `toudou.renameCategoryInline` | Menu contextuel sur catégorie |
| `toudou.deleteCategoryInline` | Menu contextuel sur catégorie |
| `toudou.changeCategoryEmoji` | Menu contextuel sur catégorie |
| `toudou.addTodoToCategory` | Icône add inline sur catégorie |
| `toudou.restoreTodoInline` | Icône restaurer sur une todo historique |
| `toudou.sortByManual` | Sous-menu tri |
| `toudou.sortByPriority` | Sous-menu tri |
| `toudou.sortByCategory` | Sous-menu tri |
| `toudou.sortByCategoryPriority` | Sous-menu tri |
| `toudou.openSettings` | Icône gear dans la barre de titre |
