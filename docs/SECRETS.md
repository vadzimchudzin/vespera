# Local secret storage

Settings secrets are stored in `settings.json` as authenticated ciphertext. When
Electron `safeStorage` is available and uses a secure OS backend, the app uses
that backend. On other systems (including Linux `basic_text`), it uses
AES-256-GCM with a random 32-byte key at
`<userDataDir>/.secrets/master.key`; the key directory is mode `0700` and the
key file is mode `0600` on POSIX. Settings writes use a synced temporary file
and atomic rename. Legacy plaintext, `enc:v1:` and `encl:v1:` credentials are
read for migration and encrypted on the next successful save.

`master.key` is required to decrypt values using the local-key format. If it is
missing, unreadable, or does not authenticate the ciphertext, startup fails
closed instead of silently replacing the credential with an empty value. Back
up and restore the complete application user-data directory as one unit; a
settings-only backup cannot recover locally encrypted secrets. Keep backups
private because they contain the key needed to decrypt the settings. Legacy
`enc:v1:` values encrypted by Electron additionally depend on the same OS
credential backend/account.

`SettingsStore.rotateSecretKey()` rotates the local master key. Call it only
while execution is stopped and with a recoverable full-directory backup. The
operation validates and decrypts loaded settings before writing newly encrypted
settings, then commits the replacement key using a restricted journal that
contains only a ciphertext hash (never a plaintext backup). Startup completes
or rolls back an interrupted rotation. The API does not rotate the separate
Telegram key at `telegram-master.key`; Telegram storage behavior is unchanged.

This protects secrets in settings files and backups from casual inspection. A
random key stored beside its ciphertext does **not** protect against an
attacker who can read the complete user-data directory, control the logged-in
account, or execute code as the application user. Use OS account/device
security and appropriately protected backups for that threat model.
