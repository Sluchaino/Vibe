import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = path.join(root, '.tools');
const secretsDir = path.join(tools, 'secrets');
const configPath = path.join(tools, 'local-development.json');
const exists = async (target) => access(target).then(() => true, () => false);

await mkdir(secretsDir, { recursive: true });
if (await exists(configPath)) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.ConnectionStrings?.Vibe || !config.ConnectionStrings?.VibeTests ||
      !config.LocalDevelopment?.SeedUsers?.length ||
      typeof config.LocalHttps?.CertificatePath !== 'string' ||
      typeof config.LocalHttps?.KeyPath !== 'string' ||
      !path.isAbsolute(config.LocalHttps.CertificatePath) ||
      !path.isAbsolute(config.LocalHttps.KeyPath) ||
      !(await exists(path.join(secretsDir, 'pg-admin-password'))) ||
      !(await exists(path.join(secretsDir, 'pg-app-password')))) {
    throw new Error('Existing local configuration is incomplete. It was not overwritten.');
  }
  const samePath = (a, b) => process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
  if (!samePath(config.LocalHttps.CertificatePath, path.join(tools, 'certs', 'localhost.pem')) ||
      !samePath(config.LocalHttps.KeyPath, path.join(tools, 'certs', 'localhost.key'))) {
    throw new Error('Existing TLS paths do not match this workspace. Configuration was not overwritten. See docs/DEV_ENVIRONMENT.md.');
  }
  console.log('Existing local configuration preserved; passwords were not rotated.');
} else {
  if (await exists(path.join(secretsDir, 'pg-admin-password')) ||
      await exists(path.join(secretsDir, 'pg-app-password'))) {
    throw new Error('Existing password files found without configuration. Nothing was overwritten.');
  }
  const adminPassword = randomBytes(32).toString('hex');
  const appPassword = randomBytes(32).toString('hex');
  const config = {
    ConnectionStrings: {
      Vibe: `Host=127.0.0.1;Port=54329;Database=vibe;Username=vibe;Password=${appPassword}`,
      VibeTests: `Host=127.0.0.1;Port=54329;Database=vibe_d1_tests;Username=vibe;Password=${appPassword}`,
    },
    LocalDevelopment: {
      SeedUsers: ['anna@vibe.local', 'boris@vibe.local'].map((userName) => ({
        UserName: userName,
        Password: `Vibe!8a${randomBytes(24).toString('hex')}`,
      })),
    },
    Auth: { SessionHours: 24, MaxFailedAccessAttempts: 5, LockoutMinutes: 15 },
    LocalHttps: {
      CertificatePath: path.join(tools, 'certs', 'localhost.pem'),
      KeyPath: path.join(tools, 'certs', 'localhost.key'),
    },
  };
  await writeFile(path.join(secretsDir, 'pg-admin-password'), adminPassword, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(secretsDir, 'pg-app-password'), appPassword, { mode: 0o600, flag: 'wx' });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Local configuration and two development accounts created in .tools/local-development.json.');
  console.log('Passwords are stored only in ignored local files and were not printed.');
}
