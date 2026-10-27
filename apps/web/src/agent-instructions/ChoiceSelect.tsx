/**
 * A small Select for the Agents rows that pick one of a few labeled values.
 * A null value shows "Mixed" across scope targets, or `emptyLabel`.
 * Fork add-on: agent instructions.
 */
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

export function ChoiceSelect<T extends string>({
  value,
  options,
  ariaLabel,
  emptyLabel = "Mixed",
  onChange,
}: {
  readonly value: T | null;
  readonly options: ReadonlyArray<readonly [value: T, label: string]>;
  readonly ariaLabel: string;
  readonly emptyLabel?: string;
  readonly onChange: (value: T) => void;
}) {
  const labelOf = (candidate: string | null) =>
    options.find(([option]) => option === candidate)?.[1];
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = options.find(([option]) => option === next);
        if (match) onChange(match[0]);
      }}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel}>
        <SelectValue>{(current: string | null) => labelOf(current) ?? emptyLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map(([option, label]) => (
          <SelectItem hideIndicator key={option} value={option}>
            {label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
