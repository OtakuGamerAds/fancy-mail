/**
 * To / Cc / Bcc: addresses become chips on comma, semicolon, Enter, Tab or leaving the field;
 * a pasted list becomes many chips; a bad address keeps a red outline until fixed (click it
 * to edit). Backspace in the empty field takes the last chip back into the field.
 *
 * Typing part of a name or address suggests people from your mail (↑ ↓ to move, Enter or Tab
 * to take one, Esc to close the list).
 */
import type { Address } from "@fancy-mail/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { AccountAvatar } from "~/components/common";
import { colorForAddress, formatAddress, isValidEmail, parseAddressList, uniqueAddresses } from "~/lib/addresses";
import { cn } from "~/lib/utils";
import { rpc } from "~/rpc/client";

export function invalidAddresses(list: Address[]): Address[] {
  return list.filter((a) => !isValidEmail(a.address));
}

/** Suggestions for what is being typed (none for an empty field or a list). */
function useSuggestions(text: string, taken: Address[]): Address[] {
  const [found, setFound] = useState<Address[]>([]);
  const query = text.trim();
  useEffect(() => {
    if (!query || /[,;]/.test(query)) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      rpc("contacts.suggest", { query, limit: 8 })
        .then((list) => {
          if (live) setFound(list);
        })
        .catch(() => {
          if (live) setFound([]);
        });
    }, 90);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  if (!query) return [];
  const takenSet = new Set(taken.map((a) => a.address.toLowerCase()));
  return found.filter((a) => !takenSet.has(a.address.toLowerCase()));
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
  const boxRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const suggestions = useSuggestions(text, value);
  const open = focused && !dismissed && suggestions.length > 0;
  useEffect(() => setHighlight(0), [suggestions.length, text]);

  const commit = (raw: string) => {
    const parsed = parseAddressList(raw);
    if (parsed.length === 0) return false;
    onChange(uniqueAddresses([...value, ...parsed.map((p) => p.address)]));
    setText("");
    return true;
  };

  const pick = (address: Address) => {
    onChange(uniqueAddresses([...value, address]));
    setText("");
    inputRef.current?.focus();
  };

  return (
    <div className="flex min-h-9 items-start gap-1">
    <div
      ref={boxRef}
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
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="h-6 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          const next = event.target.value;
          setDismissed(false);
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
          if (open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(suggestions[Math.min(highlight, suggestions.length - 1)]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
              return;
            }
          }
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
          setFocused(false);
          if (text.trim()) commit(text);
        }}
      />
      {open ? <SuggestionList anchor={boxRef.current} items={suggestions} highlight={highlight} onHover={setHighlight} onPick={pick} /> : null}
    </div>
      {trailing ? <span className="flex h-9 shrink-0 items-center gap-1">{trailing}</span> : null}
    </div>
  );
}

/** The list under the field, in a portal so the composer's clipping doesn't cut it off. */
function SuggestionList({
  anchor,
  items,
  highlight,
  onHover,
  onPick,
}: {
  anchor: HTMLElement | null;
  items: Address[];
  highlight: number;
  onHover(index: number): void;
  onPick(address: Address): void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const update = () => setRect(anchor.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, items.length]);
  if (!rect) return null;
  const below = window.innerHeight - rect.bottom > 280;
  // Starts under the typing, past the "To" label.
  const left = rect.left + 56;
  const width = Math.min(420, Math.max(260, rect.width - 56), window.innerWidth - left - 8);
  return createPortal(
    <div
      role="listbox"
      className="dropdown-glass fixed z-[90] max-h-72 overflow-y-auto rounded-lg p-1 text-popover-foreground shadow-xl shadow-black/30"
      style={{ left, width, ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }) }}
      // Keeps the focus in the field.
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((a, index) => (
        <div
          key={a.address}
          role="option"
          aria-selected={index === highlight}
          className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5", index === highlight && "bg-accent")}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(a)}
        >
          <AccountAvatar account={{ displayName: a.name ?? "", email: a.address, color: colorForAddress(a.address) }} size={24} />
          <div className="min-w-0 flex-1">
            {a.name ? <div className="truncate text-sm">{a.name}</div> : null}
            <div className={cn("truncate", a.name ? "text-muted-foreground text-xs" : "text-sm")}>{a.address}</div>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
