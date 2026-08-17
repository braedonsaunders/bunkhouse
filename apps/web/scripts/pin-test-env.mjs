/**
 * The ordinary test command is hermetic even when the parent shell or a local
 * environment file points at production infrastructure. Live verification is
 * an explicit, separately named command and opts in before this module loads.
 */
if (process.env.BUNKHOUSE_VERIFY_PROVIDERS !== '1') {
  for (const name of [
    'APPKIT_STORAGE_ACCESS_KEY_ID',
    'APPKIT_STORAGE_BUCKET',
    'APPKIT_STORAGE_ENDPOINT',
    'APPKIT_STORAGE_SECRET_ACCESS_KEY',
    'BUNKHOUSE_BRIDGE_AMI_HOST',
    'BUNKHOUSE_BRIDGE_AMI_PASSWORD',
    'BUNKHOUSE_DB_URL',
    'BUNKHOUSE_DESK_TOKEN',
    'BUNKHOUSE_DESK_URL',
    'BUNKHOUSE_LAB_IMAP_HOST',
    'BUNKHOUSE_LAB_SMTP_HOST',
    'BUNKHOUSE_REDIS_URL',
    'BUNKHOUSE_SUPER_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_URL',
  ]) {
    delete process.env[name]
  }
}

if (process.env.BUNKHOUSE_VERIFY_DATABASE !== '1') delete process.env.BUNKHOUSE_TEST_DB_URL
process.env.NODE_ENV = 'test'
