import { FORK_BRAND_ASSET_PATHS } from "./fork-brand-assets.mjs"; // Fork add-on: ndev web icons.

export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

// Fork add-on: every brand serves the fork's web icons.
const FORK_WEB_ICON_SOURCE_PATHS = /* Fork add-on */ {
  faviconIco: FORK_BRAND_ASSET_PATHS.faviconIco, // Fork add-on
  favicon16Png: FORK_BRAND_ASSET_PATHS.favicon16Png, // Fork add-on
  favicon32Png: FORK_BRAND_ASSET_PATHS.favicon32Png, // Fork add-on
  appleTouchIconPng: FORK_BRAND_ASSET_PATHS.appleTouchIconPng, // Fork add-on
} as const; // Fork add-on

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: FORK_WEB_ICON_SOURCE_PATHS, // Fork add-on
  nightly: FORK_WEB_ICON_SOURCE_PATHS, // Fork add-on
  production: FORK_WEB_ICON_SOURCE_PATHS, // Fork add-on
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

// Fork add-on: Icon Composer's export still refreshes upstream's development icons.
const UPSTREAM_DEVELOPMENT_PUBLIC_ICON_SOURCE_PATHS = /* Fork add-on */ {
  faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
  favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
  favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
  appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
} as const; // Fork add-on

// Fork add-on: shared by the fork and upstream source maps.
function resolveIconOverridesFromSources /* Fork add-on */(
  sourcePaths: Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>, // Fork add-on
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return resolveIconOverridesFromSources(sourcePaths, targetDirectory); // Fork add-on
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

// Fork add-on: keep Icon Composer's upstream development exports intact. The fork's own
// artwork is wired by resolveWebIconOverrides and supplied in assets/ndev.
export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = /* Fork add-on */ resolveIconOverridesFromSources(
  UPSTREAM_DEVELOPMENT_PUBLIC_ICON_SOURCE_PATHS, // Fork add-on
  "apps/web/public",
);
