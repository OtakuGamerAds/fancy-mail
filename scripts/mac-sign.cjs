// electron-builder's mac.sign hook for Fancy Mail's own certificate (scripts/dist.mjs sets it
// when FANCY_MAIL_MAC_SIGN_IDENTITY is there), the way T3 Code's scripts/sign-macos.ts hands
// signing to @electron/osx-sign (MIT License — see THIRD_PARTY_LICENSE_T3CODE.txt).
//
// Why a certificate of our own (self-signed, free): macOS knows an app by its signature. Signed
// ad hoc, every build is a new app to it, so after each update the Keychain asks again for the
// key that unlocks the saved passwords, and the app can't update itself (Squirrel.Mac only
// installs an update signed like the running app). Signed by the same certificate every time,
// each version is the same app: "Always Allow" sticks and updates install in the app.
// (Gatekeeper still asks once on the first open: only Apple's Developer ID avoids that.)
//
//   FANCY_MAIL_MAC_SIGN_IDENTITY   the certificate's SHA-1 (the keychain has its private key)
//   FANCY_MAIL_MAC_SIGN_KEYCHAIN   that keychain (CI imports the certificate into its own)
const { createRequire } = require("node:module");
const path = require("node:path");

/** @electron/osx-sign, as electron-builder itself has it. */
function osxSign() {
  const builder = require.resolve("electron-builder/package.json", { paths: [path.join(__dirname, "..", "apps", "desktop")] });
  const lib = createRequire(builder).resolve("app-builder-lib/package.json");
  return createRequire(lib)("@electron/osx-sign");
}

module.exports = async function sign(options) {
  const identity = process.env.FANCY_MAIL_MAC_SIGN_IDENTITY;
  if (!identity) throw new Error("FANCY_MAIL_MAC_SIGN_IDENTITY isn't set: no certificate to sign with.");
  await osxSign().signApp({
    ...options,
    identity,
    identityValidation: false,
    keychain: process.env.FANCY_MAIL_MAC_SIGN_KEYCHAIN || options.keychain,
    // Apple's timestamp server is for Apple's certificates; nothing checks a time on ours.
    timestamp: "none",
  });
};
