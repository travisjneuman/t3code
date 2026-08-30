"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Seal unsigned macOS bundles before electron-builder creates DMG/ZIP output.
 *
 * This is not Developer ID signing or notarization. It gives Squirrel.Mac a
 * valid resource envelope for local/unsigned Nightly packages; Gatekeeper can
 * still reject those packages when they are downloaded directly. The explicit
 * designated requirement is stable across builds. Plain ad-hoc signatures use
 * the build's code hash as their requirement, which makes every update look
 * unrelated to the currently installed app and causes ShipIt to reject it.
 */
module.exports = async function signMacAdHoc(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  await execFileAsync("codesign", ["--deep", "--force", "--sign", "-", appPath]);
  await execFileAsync("codesign", [
    "--force",
    "--sign",
    "-",
    "--requirements",
    '=designated => identifier "dev.neuman.t3code"',
    appPath,
  ]);
};
