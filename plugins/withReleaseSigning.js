const { withAppBuildGradle } = require('expo/config-plugins');

// android/ is gitignored CNG output, so `expo prebuild --clean` rewrites
// app/build.gradle from Expo's template and discards any hand-edit. This plugin
// re-applies the release signing config on every prebuild instead.
//
// Secrets never enter build.gradle: the generated Groovy reads them at build
// time from credentials/keystore.properties, which is gitignored.

const RELEASE_SIGNING_CONFIG = `
        release {
            def keystorePropsFile = rootProject.file('../credentials/keystore.properties')
            if (keystorePropsFile.exists()) {
                def keystoreProps = new Properties()
                keystorePropsFile.withInputStream { keystoreProps.load(it) }
                storeFile rootProject.file('../' + keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            } else {
                // Keep every build working when credentials are absent (fresh
                // clone, CI without secrets) rather than failing at configuration
                // time, which would break debug builds too. Loud, not silent.
                logger.warn('WARNING: credentials/keystore.properties not found — ' +
                    'release artifacts will be signed with the DEBUG key and are NOT uploadable to Play.')
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }`;

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;

    if (gradle.includes('credentials/keystore.properties')) {
      return cfg; // already applied
    }

    // 1. Add a `release` signing config alongside the template's `debug` one.
    const debugSigningBlock = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;
    if (!gradle.includes(debugSigningBlock)) {
      throw new Error(
        '[withReleaseSigning] Could not find the debug signingConfig block. ' +
          'Expo changed its build.gradle template — update this plugin before shipping.'
      );
    }
    gradle = gradle.replace(debugSigningBlock, debugSigningBlock + RELEASE_SIGNING_CONFIG);

    // 2. Point the release build type at it instead of the debug key.
    const templateReleaseSigning = `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;
    if (!gradle.includes(templateReleaseSigning)) {
      throw new Error(
        '[withReleaseSigning] Could not find the release buildType signingConfig. ' +
          'Expo changed its build.gradle template — update this plugin before shipping.'
      );
    }
    gradle = gradle.replace(
      templateReleaseSigning,
      `        release {
            signingConfig signingConfigs.release`
    );

    cfg.modResults.contents = gradle;
    return cfg;
  });

module.exports = withReleaseSigning;
