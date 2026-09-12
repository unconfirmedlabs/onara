/**
 * Build and pack the SDK, then load the tarball from an isolated consumer.
 * Workspace tests import `src/`, while a consumer imports the `exports` map;
 * this check keeps those two paths honest and verifies that peer packages are
 * resolvable without relying on the workspace's ignored `dist` directory.
 */
import { $ } from 'bun'
import { existsSync, readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sdk = resolve(import.meta.dir, '..')
const root = resolve(sdk, '..')
const moduleRoots = [
  join(sdk, 'node_modules'),
  join(root, 'node_modules'),
]

const fail = (message: string): never => {
  console.error(`check-package: ${message}`)
  process.exit(1)
}

const packagePath = (rootPath: string, name: string): string =>
  name.startsWith('@')
    ? join(rootPath, ...name.split('/'))
    : join(rootPath, name)

const sourceOf = async (name: string): Promise<string | undefined> => {
  for (const modules of moduleRoots) {
    const candidate = packagePath(modules, name)
    if (existsSync(candidate)) return realpath(candidate)
  }
  return undefined
}

// Keep the consumer check deterministic. Running `bun x tsc` from a temporary
// directory can install npm's unrelated `tsc` package when no ancestor bin is
// visible; use the compiler already installed for this workspace instead.
const compiler = [
  join(sdk, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
].find((candidate) => existsSync(candidate))
if (compiler === undefined) {
  fail('could not find the workspace TypeScript compiler; run bun install first')
}

const peerSources = new Map<string, string>()
for (const name of ['@unconfirmed/sui-effect', 'effect', '@mysten']) {
  const source = await sourceOf(name)
  if (source === undefined) {
    fail(`could not resolve peer package ${name}; run bun install first`)
  }
  peerSources.set(name, source)
}

await rm(join(sdk, 'dist'), { recursive: true, force: true })
await $`bun run build`.cwd(sdk).quiet()

const work = await mkdtemp(join(tmpdir(), 'onara-package-'))
try {
  await $`bun pm pack --destination ${work}`.cwd(sdk).quiet()
  const tarballs = (await readdir(work)).filter((name) => name.endsWith('.tgz'))
  const tarball = tarballs[0]
  if (tarball === undefined) fail('bun pm pack produced no tarball')

  const consumer = join(work, 'consumer')
  const modules = join(consumer, 'node_modules')
  const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as {
    name: string
  }
  const [scope, bareName] = manifest.name.startsWith('@')
    ? manifest.name.split('/')
    : [undefined, manifest.name]
  const installed = join(
    modules,
    ...(scope === undefined ? [bareName!] : [scope, bareName!]),
  )
  await mkdir(scope === undefined ? modules : join(modules, scope), {
    recursive: true,
  })
  const extracted = join(work, 'extracted')
  await mkdir(extracted, { recursive: true })
  await $`tar -xzf ${join(work, tarball)} -C ${extracted}`.quiet()
  await $`mv ${join(extracted, 'package')} ${installed}`.quiet()

  for (const required of ['dist/index.js', 'dist/index.d.ts', 'package.json', 'README.md']) {
    if (!existsSync(join(installed, required))) {
      fail(`the packed tarball has no ${required}`)
    }
  }
  const packedFiles = await $`find ${installed} -type f`.text()
  if (/\.test\.(?:ts|tsx|js|jsx|d\.ts)(?:\n|$)/m.test(packedFiles)) {
    fail('the packed tarball contains test source files')
  }

  const unconfirmedScope = join(modules, '@unconfirmed')
  await mkdir(unconfirmedScope, { recursive: true })
  await symlink(peerSources.get('@unconfirmed/sui-effect')!, join(unconfirmedScope, 'sui-effect'), 'dir')
  await symlink(peerSources.get('effect')!, join(modules, 'effect'), 'dir')
  await symlink(peerSources.get('@mysten')!, join(modules, '@mysten'), 'dir')

  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'onara-consumer', private: true, type: 'module' }, null, 2),
  )
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ESNext', 'DOM'],
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['consume.ts'],
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(consumer, 'consume.ts'),
    `import { SuiGrpcClient } from '@mysten/sui/grpc'\n` +
      `import { Onara, onara } from '@unconfirmed/onara'\n` +
      `const client = new SuiGrpcClient({ network: 'devnet', baseUrl: 'https://sui.example.com' }).$extend(onara({ url: 'https://onara.example.com' }))\n` +
      `const _status: () => Promise<unknown> = client.onara.status\n` +
      `if (typeof Onara.layerTest !== 'function' || typeof _status !== 'function') throw new Error('Onara exports are incomplete')\n`,
  )
  await $`${compiler} -p ${join(consumer, 'tsconfig.json')}`.cwd(consumer).quiet()
  await $`bun run ${join(consumer, 'consume.ts')}`.cwd(consumer).quiet()
  console.log('check-package: packed SDK imports and typechecks in an isolated consumer')
} finally {
  await rm(work, { recursive: true, force: true })
}
