/**
 * electron-builder afterPack hook — ad-hoc sign the macOS bundle.
 *
 * Without a "Developer ID Application" certificate electron-builder skips
 * signing entirely, which leaves the app carrying the raw linker-signed
 * Electron binary: resources unsealed, Info.plist unbound, identifier still
 * "Electron". macOS then has no stable identity to hang TCC grants on, so the
 * Accessibility and Screen Recording permissions the capture hotkeys need
 * cannot be granted reliably.
 *
 * An ad-hoc signature (`codesign --sign -`) seals the bundle and binds
 * Info.plist under the app's real bundle id. The identity is the cdhash, so
 * every rebuild is a new identity: macOS forgets the granted permissions and
 * they have to be re-approved. A real Developer ID avoids that — set
 * CSC_IDENTITY_AUTO_DISCOVERY / mac.identity once one is available and
 * electron-builder signs instead, making this hook a no-op.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // electron-builder already signed it with a real certificate — leave it be.
  if (context.packager.platformSpecificBuildOptions.identity) return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // codesign refuses to sign a bundle carrying extended attributes
  // ("resource fork, Finder information, or similar detritus not allowed");
  // the extracted Electron zip brings some along.
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign', '-',
    '--identifier', context.packager.appInfo.id,
    appPath,
  ], { stdio: 'inherit' });

  console.log(`  • ad-hoc signed  ${path.basename(appPath)}`);
};
