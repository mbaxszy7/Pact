import identities from '../app-identities.json' with { type: 'json' }

const kind = 'production-local'
const identity = identities[kind]

export default {
  extends: './electron-builder.yml',
  appId: identity.appId,
  productName: identity.name,
  publish: null,
  directories: { output: `release/${identity.outputDirectory}` },
  extraMetadata: {
    name: identity.packageName,
    productName: identity.name,
    pactBuildProfile: kind,
  },
  artifactName: `Pact-Production-Local-\${version}-\${os}-\${arch}.\${ext}`,
  win: { executableName: identity.name },
  nsis: { shortcutName: identity.name, uninstallDisplayName: identity.name },
}
