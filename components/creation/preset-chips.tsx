"use client";

import { matchPreset, type CreationPreset } from "@/lib/creation/creation-presets";

/**
 * A wrapping row of preset chips that write into the field beside them.
 *
 * Toggle buttons rather than radios: unlike the duration and speech fieldsets
 * next door, this is not an exclusive choice that has to resolve to one of the
 * options. The text field remains the answer, so a chip only reports whether
 * the current text happens to be the one it writes.
 *
 * Selection is derived, never stored. Once a parent edits a generated sentence
 * the text stops matching and the chip quietly deselects, which is why editing
 * can never cost them their words.
 */
export function PresetChips({
  presets,
  value,
  onSelect,
  label,
  idPrefix,
}: {
  presets: readonly CreationPreset[];
  /** Current field text. Drives which chip, if any, reads as selected. */
  value: string;
  onSelect: (value: string) => void;
  /** Describes the group to assistive tech, e.g. "پیشنهادها برای توضیح صحنه". */
  label: string;
  /** Distinguishes this group's ids from the other groups on the page. */
  idPrefix: string;
}) {
  const active = matchPreset(presets, value);
  const headingId = `${idPrefix}-preset-label`;

  return (
    <div className="space-y-1.5">
      <p id={headingId} className="text-xs text-text-dark/50">
        {label}
      </p>
      <div role="group" aria-labelledby={headingId} className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const selected = active?.label === preset.label;
          return (
            <button
              key={preset.label}
              type="button"
              // Not aria-checked: these are independent toggles, and none of
              // them being pressed is a normal, valid state.
              aria-pressed={selected}
              onClick={() => onSelect(preset.value)}
              className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-3 py-2 text-sm transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candy-pink ${
                selected
                  ? "neu-pressed-pink font-semibold"
                  : "neu-raised neu-interactive text-text-dark/70"
              }`}
            >
              {/* A tick as well as colour: with twenty-odd chips on a page, a
                  tinted background alone is easy to miss, and it is the only
                  signal a parent has that their click landed. */}
              {selected && (
                <span aria-hidden="true" className="text-candy-pink">
                  ✓
                </span>
              )}
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
