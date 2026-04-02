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
| Toudou: Restaurer depuis l'historique | `toudou.restoreTodo` | Quick pick d'une todo complétée à restaurer |
| Toudou: Purger l'historique | `toudou.purgeHistory` | Supprime tout l'historique après confirmation |

## Commandes internes (non visibles dans la palette)

Ces commandes sont appelées uniquement depuis la TreeView via les menus/icônes.

| ID | Déclencheur |
|----|-------------|
| `toudou.completeTodoInline` | Icône check sur une todo |
| `toudou.deleteTodoInline` | Icône trash sur une todo |
| `toudou.editTodoTitle` | Menu contextuel "Éditer" |
| `toudou.editTodoDescription` | Menu contextuel "Éditer la description" |
| `toudou.changeTodoCategory` | Menu contextuel "Changer de catégorie" |
| `toudou.renameCategoryInline` | Menu contextuel sur catégorie |
| `toudou.deleteCategoryInline` | Menu contextuel sur catégorie |
| `toudou.restoreTodoInline` | Icône restaurer sur une todo historique |
