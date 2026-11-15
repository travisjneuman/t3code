import { Button } from "../components/ui/button";

export function CheckoutFolderHint({ searchingCheckout, foundRoot, addExisting, canCheckFolder, useOwnFolder, label, setCloneInstead, setUseOwnFolder, setExistingPathOverride }: {
  searchingCheckout: boolean;
  foundRoot: string | null;
  addExisting: boolean;
  canCheckFolder: boolean;
  useOwnFolder: boolean;
  label: string | undefined;
  setCloneInstead: (value: boolean) => void;
  setUseOwnFolder: (value: boolean) => void;
  setExistingPathOverride: (value: string | null) => void;
}) {
  return searchingCheckout ? ( // Fork add-on(existing-checkout)
    <p className="text-muted-foreground text-xs">
      Looking for a checkout already on {label ?? "that machine"}…
    </p>
  ) : foundRoot !== null ? (
    <p className="flex flex-wrap items-center gap-x-1 text-muted-foreground text-xs">
      {addExisting ? "Found an existing checkout." : `${label ?? "That machine"} already has a checkout.`}
      <Button type="button" variant="link" size="xs" onClick={() => {
        setCloneInstead(addExisting);
        setUseOwnFolder(false);
      }}>
        {addExisting ? "Clone a new copy instead" : "Use it instead"}
      </Button>
    </p>
  ) : canCheckFolder ? (
    <p className="flex flex-wrap items-center gap-x-1 text-muted-foreground text-xs">
      {useOwnFolder ? "Enter the folder of the checkout already there." : `No checkout found where ${label ?? "that machine"} keeps projects.`}
      <Button type="button" variant="link" size="xs" onClick={() => {
        setUseOwnFolder(!useOwnFolder);
        setExistingPathOverride(null);
      }}>
        {useOwnFolder ? "Clone a new copy instead" : "Use a folder already there"}
      </Button>
    </p>
  ) : null;
}
