/**
 * To / Cc / Bcc: addresses become chips on comma, semicolon, Enter, Tab or leaving the field;
 * a pasted list becomes many chips; a bad address keeps a red outline until fixed (click it
 * to edit). Backspace in the empty field takes the last chip back into the field.
 */
import type { Address } from "@fancy-mail/contracts";
import { XIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { formatAddress, isValidEmail, parseAddressList, uniqueAddresses } from "~/lib/addresses";
import { cn } from "~/lib/utils";

export function invalidAddresses(list: Address[]): Address[] {
  return list.filter((a) => !isValidEmail(a.address));
}

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
  placeholder,
}: {
  label: string;
  value: Address[];
  onChange(next: Address[]): void;
  autoFocus?: boolean;
  trailing?: ReactNode;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const parsed = parseAddressList(raw);
    if (parsed.length === 0) return false;
    onChange(uniqueAddresses([...value, ...parsed.map((p) => p.address)]));
    setText("");
    return true;
  };

  return (
    <div className="flex min-h-9 items-start gap-1">
    <div
      className="flex min-h-9 min-w-0 flex-1 cursor-text flex-wrap items-center gap-1 py-1"
      onClick={() => inputRef.current?.focus()}
    >
      <span className="w-14 shrink-0 text-muted-foreground text-sm">{label}</span>
      {value.map((address, index) => {
        const valid = isValidEmail(address.address);
        return (
          <span
            key={`${address.address}-${index}`}
            title={formatAddress(address)}
            className={cn(
              "inline-flex h-6 max-w-64 items-center gap-1 rounded-md ps-2 pe-0.5 text-[13px]",
              valid ? "bg-white/[0.07] text-foreground" : "bg-destructive/12 text-destructive-foreground ring-1 ring-destructive/50",
            )}
            onClick={(event) => {
              event.stopPropagation();
              if (valid) return;
              // Fix a bad address: back into the field.
              onChange(value.filter((_, i) => i !== index));
              setText(address.address);
              inputRef.current?.focus();
            }}
          >
            <span className="truncate">{address.name || address.address}</span>
            <button
              type="button"
              aria-label={`Remove ${address.address}`}
              className="grid size-4.5 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-white/10 hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((_, i) => i !== index));
              }}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        value={text}
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={value.length === 0 ? placeholder : undefined}
        spellCheck={false}
        autoComplete="off"
        className="h-6 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
        onChange={(event) => {
          const next = event.target.value;
          if (/[,;\n]/.test(next)) {
            commit(next);
          } else {
            setText(next);
          }
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (/[,;\n]|\s\S+@/.test(pasted)) {
            event.preventDefault();
            commit(text + pasted);
          }
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === "Tab") && text.trim()) {
            if (event.key === "Enter") event.preventDefault();
            commit(text);
          } else if (event.key === "Backspace" && !text && value.length > 0) {
            event.preventDefault();
            const last = value[value.length - 1]!;
            onChange(value.slice(0, -1));
            setText(last.address);
          }
        }}
        onBlur={() => {
          if (text.trim()) commit(text);
        }}
      />
    </div>
      {trailing ? <span className="flex h-9 shrink-0 items-center gap-1">{trailing}</span> : null}
    </div>
  );
}
