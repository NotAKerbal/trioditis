New: deploy/trioditis restore puts a backup back, checking it first and backing up the server as it was.
Security: Backups are encrypted with the install's own key, kept apart with the server's keys.
Fixed: A restored backup never sends a message twice: sends it held as on their way come back as unknown.
Improved: The updater backs the server up before each update, and restores that backup if the update fails.
Fixed: A server installed from dev now says to choose Nightly, instead of finding nothing to install.
Improved: The updater keeps the checkout on its branch, so git pull still works for updating by hand.
Fixed: The installer stops before a database image change without a backup, or bad hand-written settings.
