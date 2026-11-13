#!/usr/bin/env bash
# CI, macOS: puts Fancy Mail's own signing certificate (the secrets MAC_SELF_SIGN_P12, a base64
# .p12, and MAC_SELF_SIGN_PASSWORD) into a keychain of its own, and hands its identity to the
# next steps (FANCY_MAIL_MAC_SIGN_IDENTITY / FANCY_MAIL_MAC_SIGN_KEYCHAIN, read by
# scripts/dist.mjs and scripts/mac-sign.cjs). Without the secret the build is signed ad hoc.
set -euo pipefail

if [[ -z "${MAC_SELF_SIGN_P12:-}" || -z "${MAC_SELF_SIGN_PASSWORD:-}" ]]; then
  echo "No MAC_SELF_SIGN_P12 / MAC_SELF_SIGN_PASSWORD: the Mac build is signed ad hoc."
  exit 0
fi

keychain="$RUNNER_TEMP/fancy-mail-signing.keychain-db"
keychain_password="$(openssl rand -hex 16)"
echo "::add-mask::$keychain_password"
p12="$RUNNER_TEMP/fancy-mail-signing.p12"
(umask 077 && printf '%s' "$MAC_SELF_SIGN_P12" | base64 --decode > "$p12")

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$p12" -k "$keychain" -P "$MAC_SELF_SIGN_PASSWORD" -T /usr/bin/codesign
# codesign may use the key without a dialog.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
# codesign signs only with a certificate this Mac trusts for code signing: trust ours here (a
# throwaway runner). A person's Mac never needs to: running and updating check the signature,
# not trust. scripts/mac-update-check.mjs takes the trust away again before it tests that.
cert="$RUNNER_TEMP/fancy-mail-signing.pem"
openssl pkcs12 -in "$p12" -nokeys -clcerts -passin "pass:$MAC_SELF_SIGN_PASSWORD" -out "$cert"
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$cert"
rm -f "$p12"

# Self-signed, so not "valid" to macOS (-v would hide it); codesign signs with it all the same.
identity="$(security find-identity -p codesigning "$keychain" | awk '/"Fancy Mail/ { print $2; exit }')"
if [[ -z "$identity" ]]; then
  security find-identity -p codesigning "$keychain"
  echo "The certificate in MAC_SELF_SIGN_P12 has no Fancy Mail code-signing identity." >&2
  exit 1
fi
# Sign a copy of a small program now, so a certificate codesign can't use fails here, clearly.
probe="$RUNNER_TEMP/fancy-mail-sign-probe"
cp /usr/bin/true "$probe"
if ! codesign --force --sign "$identity" --keychain "$keychain" --timestamp=none "$probe"; then
  echo "--- what macOS sees ---"
  security find-identity -p codesigning "$keychain" || true
  security find-identity -v -p codesigning || true
  security verify-cert -c "$cert" -p codeSign || true
  security dump-trust-settings -d || true
  echo "codesign can't sign with Fancy Mail's certificate." >&2
  exit 1
fi
codesign -dv "$probe" 2>&1 | grep -E "^Authority|^Signature" || true
echo "FANCY_MAIL_MAC_SIGN_IDENTITY=$identity" >> "$GITHUB_ENV"
echo "FANCY_MAIL_MAC_SIGN_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
echo "FANCY_MAIL_MAC_SIGN_CERT=$cert" >> "$GITHUB_ENV"
echo "Mac builds are signed with Fancy Mail's certificate ($identity)."
