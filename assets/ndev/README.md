# ndev.t3code artwork

The fork identity pairs the neumux-inspired blue/cyan/violet ribbon with a silver
`nt3` / `code` lockup on a midnight navy tile. A continuous bright white rim is the
fixed Dock signifier; it does not change with the app theme.

The canonical master is kept in Proton Drive at
`Desktop/Logos/ndev/t3code/ndev.t3code-master.png` and must never be altered.
`source/master.png` is its authorized repository working copy (SHA-256
`022db933b35e8bfb71f3fee7a89e2892e6601169bc0ff8ad95035c18631a8d00`). Make
future adaptations from the repository copy and keep them in the repository;
never write generated or edited files back to the canonical master or let
automatic syncing overwrite it.

The master is a native 1254×1254 raster. The image generator was asked for
2048×2048 but returned 1254×1254; no enlarged output is presented as additional
native detail. The transparent perimeter was finished with a smooth mask and
white stroke. Its 1110×1110 tile starts at (72, 72).
`favicon.svg` is the editable, simplified small-size ribbon mark, not a vector
trace of the full raster artwork. Keep the original neumux and upstream T3
sources unchanged.

Regenerate the fork's exports from the repository root:

```sh
vp run icons:export:ndev
```

The exporter uses the existing marketing workspace's Sharp dependency and Node's
native TypeScript support for the ICO encoder. It reads the two sources above,
creates assets in this directory, and refreshes the web client's public icon
copies. It does not regenerate either source or use an image service.

## Formats and use

| Asset                                         | Intended use                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `app-icon-macos-1024.png`                     | macOS: 824px icon body with 100px transparent margins                                           |
| `app-icon.icns`                               | macOS multi-resolution icon, including Retina representations                                   |
| `app-icon-1024.png`, `app-icon.ico`           | Linux/Windows and general app use                                                               |
| `favicon.svg`, `favicon.ico`, `favicon-*.png` | Simplified ribbon at 16, 32 and 48px                                                            |
| `apple-touch-icon.png`                        | Opaque 180px Apple touch icon                                                                   |
| `icon-192.png`, `icon-512.png`                | Web app manifest icons (`purpose: any`)                                                         |
| `site-icon.webp`                              | Lossless square icon for a future site                                                          |
| `og-image.png`, `og-image@2x.png`             | 1200×630 social preview and 2400×1260 source composition                                        |
| `mobile/`                                     | iOS square, Android adaptive foreground/background, monochrome, splash and notification artwork |

Small favicon and ICO representations use the simplified ribbon because the
two-line wordmark is too dense at those sizes. The full icon keeps the lettering.
The social-card lettering is rasterized locally using Arial/Helvetica; exact
font metrics can vary on hosts without those fonts. No fonts or remote assets
load when a finished image is displayed.

Desktop source launches and both package channels, web client favicons, PWA icons
and the fork README consume this artwork. `og-image.png` was uploaded as the
fork's GitHub repository social preview on 2026-10-14 and can also serve a future site at
`https://t3.neuman.dev`; that site has not launched. Existing packaging
generates ICNS from the macOS PNG. The standalone ICNS additionally supplies
the simplified small-size representations. Site and mobile files are ready for
integration; upstream marketing and mobile app configuration remain unchanged.

The upstream `icons:export` command still operates on the original Icon Composer
projects and refreshes their development favicon copies. After deliberately
using it, run `icons:export:ndev` to restore the fork's public icons.

Asset generation is not an app build or installed-app acceptance. The installed
app adopts the packaged artwork on its next normal source update/rebuild.
