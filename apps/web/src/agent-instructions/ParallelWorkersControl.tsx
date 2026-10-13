/**
 * The Parallel workers control: common counts in a select, and Custom for any
 * other count the setting allows, typed into a number field beside it. A null
 * value shows "Mixed" across scope targets.
 * Fork add-on: agent instructions.
 */
import {
  DEFAULT_AGENT_PARALLEL_WORKERS,
  MAX_AGENT_PARALLEL_WORKERS,
  MIN_AGENT_PARALLEL_WORKERS,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../components/ui/number-field";
import { ChoiceSelect } from "./ChoiceSelect";

const COMMON_COUNTS = [1, 2, 4, 8, 12, 16, 20, 25, 30];
const CUSTOM = "custom";
const OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ...COMMON_COUNTS.map((count) => [String(count), String(count)] as const),
  [CUSTOM, "Custom…"],
];

function clampCount(count: number): number {
  return Math.min(
    MAX_AGENT_PARALLEL_WORKERS,
    Math.max(MIN_AGENT_PARALLEL_WORKERS, Math.round(count)),
  );
}

export function ParallelWorkersControl({
  value,
  onChange,
}: {
  readonly value: number | null;
  readonly onChange: (value: number) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  // The typed count until it commits; a new saved value replaces it.
  const [draft, setDraft] = useState({ base: value, count: value });
  const count = draft.base === value ? draft.count : value;
  const custom = value !== null && (customOpen || !COMMON_COUNTS.includes(value));

  return (
    <div className="flex items-center gap-2">
      {custom ? (
        <NumberField
          value={count}
          min={MIN_AGENT_PARALLEL_WORKERS}
          max={MAX_AGENT_PARALLEL_WORKERS}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={(next) => setDraft({ base: value, count: next })}
          onValueCommitted={(next) => {
            if (next === null) {
              setDraft({ base: value, count: value });
              return;
            }
            const clamped = clampCount(next);
            setDraft({ base: clamped, count: clamped });
            if (clamped !== value) onChange(clamped);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label="Fewer parallel workers" />
            <NumberFieldInput
              aria-label="Custom parallel workers"
              size={2}
              className="field-sizing-content w-auto min-w-[2ch] grow-0 text-right"
            />
            <NumberFieldIncrement aria-label="More parallel workers" />
          </NumberFieldGroup>
        </NumberField>
      ) : null}
      <ChoiceSelect
        value={value === null ? null : custom ? CUSTOM : String(value)}
        options={OPTIONS}
        ariaLabel="Parallel workers"
        onChange={(next) => {
          if (next === CUSTOM) {
            setCustomOpen(true);
            // Across mixed targets there is no count to edit yet; start from the default.
            if (value === null) onChange(DEFAULT_AGENT_PARALLEL_WORKERS);
            return;
          }
          setCustomOpen(false);
          onChange(Number(next));
        }}
      />
    </div>
  );
}
