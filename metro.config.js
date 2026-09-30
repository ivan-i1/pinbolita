const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// react-native-game-engine -> rxjs@6 -> tslib@1 is compiled expecting CommonJS
// interop. Expo SDK 53+ turns on Metro's package-exports resolution by default,
// which hands rxjs the ESM build instead, so `tslib.default` is undefined and
// destructuring `__extends` throws before anything renders — a blank page on web.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
