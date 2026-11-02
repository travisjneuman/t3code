// Fork add-on: desktop bridge members the fork core adds to upstream's DesktopBridge.
// Members merge into the interface through module augmentation, so ipc.ts keeps
// upstream's declaration; each add-on augments it in its own contracts file.
declare module "./ipc.ts" {
  interface DesktopBridge {
    /**
     * Presents a native confirmation above embedded WebContentsViews. Optional
     * so older desktop shells can continue using the renderer confirmation host.
     */
    confirm?: (message: string) => Promise<boolean>;
  }
}

export {};
