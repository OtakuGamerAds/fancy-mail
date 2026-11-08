/**
 * The sidebar's search field. Typing narrows every view at once: the list shows what matches
 * in the selected group, account or label, and the sidebar counts the matches in each, so a
 * click goes straight to them. Clearing it brings everything back. The button beside it opens
 * the advanced search, which writes the query for you.
 */
import { QUERY_SYNTAX_HELP, quoteQueryValue, type Account } from "@fancy-mail/contracts";
import { ChevronRightIcon, SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { QuietSelect, type Choice } from "~/components/selects";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDebounced } from "~/hooks/useDebounced";
import { cn } from "~/lib/utils";
import { listNav } from "~/state/listNav";
import { useDirectory, useSearchFacets } from "~/state/queries";
import { useUi } from "~/state/ui";

export function SidebarSearch() {
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    listNav.focusSearch = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    return () => {
      listNav.focusSearch = () => {};
    };
  }, []);

  return (
    <div className="flex items-center gap-1">
      <label
        className={cn(
          "relative flex h-8 min-w-0 flex-1 cursor-text items-center gap-2 rounded-[var(--control-radius)] bg-sidebar-control-surface px-[var(--sidebar-row-content-inset)] text-sm ring-1 ring-sidebar-border transition-shadow focus-within:ring-2 focus-within:ring-ring",
          search && "ring-primary/45",
        )}
      >
        <SearchIcon className={cn("size-4 shrink-0", search ? "text-sidebar-foreground" : "text-[var(--sidebar-icon-color)]")} />
        <input
          ref={inputRef}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (search) setSearch("");
              else event.currentTarget.blur();
            } else if (event.key === "ArrowDown" || event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
              const first = listNav.threads[0];
              if (first) useUi.getState().setFocusedThread(first.id);
            }
          }}
          placeholder="Search mail"
          aria-label="Search mail"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search (Esc)"
            onClick={() => {
              setSearch("");
              inputRef.current?.focus();
            }}
            className="-me-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-sidebar-muted-foreground hover:bg-white/10 hover:text-sidebar-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : !focused ? (
          <Kbd>/</Kbd>
        ) : null}
      </label>
      <AdvancedSearch />
    </div>
  );
}

// ── What the sidebar counts while searching ─────────────────────────────────────────────────

export interface SearchMatches {
  /** A search is on (the sidebar shows matches instead of unread counts). */
  active: boolean;
  total: number;
  account(id: string): number;
  accounts(list: Account[]): number;
  label(id: string): number;
}

export function useSearchMatches(): SearchMatches {
  const search = useDebounced(useUi((s) => s.search), 150).trim();
  const facets = useSearchFacets(search);
  const data = search ? facets.data : undefined;
  const account = (id: string) => data?.byAccount[id] ?? 0;
  return {
    active: search.length > 0,
    total: data?.total ?? 0,
    account,
    accounts: (list) => list.reduce((sum, a) => sum + account(a.id), 0),
    label: (id) => data?.byLabel[id] ?? 0,
  };
}

/** A match count in the sidebar: tinted, so it reads as "found here", not "unread". */
export function MatchCount({ value }: { value: number }) {
  if (value <= 0) return null;
  return (
    <span className="min-w-5 animate-fade-in rounded-full bg-primary/18 px-1.5 text-center text-[11px] text-sidebar-foreground tabular-nums leading-[18px]">
      {value > 9999 ? "9999+" : value.toLocaleString()}
    </span>
  );
}

// ── Advanced search ─────────────────────────────────────────────────────────────────────────

type Within = "any" | "7d" | "1m" | "6m" | "1y";

const WITHIN: Choice<Within>[] = [
  { value: "any", label: "Any time" },
  { value: "7d", label: "Last week" },
  { value: "1m", label: "Last month" },
  { value: "6m", label: "Last 6 months" },
  { value: "1y", label: "Last year" },
];

interface AdvancedFields {
  from: string;
  to: string;
  subject: string;
  words: string;
  without: string;
  within: Within;
  labelId: string;
  attachment: boolean;
  unread: boolean;
  starred: boolean;
}

const EMPTY: AdvancedFields = {
  from: "",
  to: "",
  subject: "",
  words: "",
  without: "",
  within: "any",
  labelId: "any",
  attachment: false,
  unread: false,
  starred: false,
};

function buildQuery(f: AdvancedFields, labelName: (id: string) => string | null): string {
  const parts: string[] = [];
  const field = (name: string, value: string) => {
    if (value.trim()) parts.push(`${name}:${quoteQueryValue(value.trim())}`);
  };
  field("from", f.from);
  field("to", f.to);
  field("subject", f.subject);
  if (f.words.trim()) parts.push(f.words.trim());
  for (const word of f.without.trim().split(/\s+/).filter(Boolean)) parts.push(`-${quoteQueryValue(word)}`);
  if (f.within !== "any") parts.push(`newer_than:${f.within}`);
  const label = f.labelId !== "any" ? labelName(f.labelId) : null;
  if (label) parts.push(`label:${quoteQueryValue(label)}`);
  if (f.attachment) parts.push("has:attachment");
  if (f.unread) parts.push("is:unread");
  if (f.starred) parts.push("is:starred");
  return parts.join(" ");
}

function AdvancedSearch() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Advanced search"
                  className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-[var(--control-radius)] text-[var(--sidebar-icon-color)] outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover data-[popup-open]:text-sidebar-foreground"
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Advanced search</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="right" align="start" sideOffset={10} padding="compact">
        {open ? <AdvancedForm onDone={() => setOpen(false)} /> : null}
      </PopoverPopup>
    </Popover>
  );
}

function AdvancedForm({ onDone }: { onDone(): void }) {
  const dir = useDirectory();
  const [fields, setFields] = useState<AdvancedFields>(EMPTY);
  const [showSyntax, setShowSyntax] = useState(false);
  const set = (patch: Partial<AdvancedFields>) => setFields((f) => ({ ...f, ...patch }));
  const labelName = (id: string) => dir.labelById.get(id)?.name ?? null;
  const query = buildQuery(fields, labelName);

  const labelChoices: Choice[] = [{ value: "any", label: "Any label" }, ...dir.labels.map((l) => ({ value: l.id, label: l.name }))];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!query) return;
    useUi.getState().setSearch(query);
    onDone();
  };

  const text = (key: "from" | "to" | "subject" | "words" | "without", label: string, placeholder: string, autoFocus = false) => (
    <label className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <Input
        size="sm"
        nativeInput
        autoFocus={autoFocus}
        value={fields[key]}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </label>
  );

  return (
    <form className="w-[22rem] space-y-2.5 py-1" onSubmit={submit}>
      <div className="font-medium text-sm">Advanced search</div>
      {text("from", "From", "name or address", true)}
      {text("to", "To", "name or address")}
      {text("subject", "Subject", "")}
      {text("words", "Has the words", "")}
      {text("without", "Doesn't have", "")}
      <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
        <span className="text-muted-foreground text-xs">Date</span>
        <QuietSelect items={WITHIN} value={fields.within} onChange={(within) => set({ within })} ariaLabel="Date" />
      </div>
      {dir.labels.length > 0 ? (
        <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
          <span className="text-muted-foreground text-xs">Label</span>
          <QuietSelect items={labelChoices} value={fields.labelId} onChange={(labelId) => set({ labelId })} ariaLabel="Label" />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 ps-[7rem] pt-0.5">
        {(
          [
            ["attachment", "Has attachment"],
            ["unread", "Unread"],
            ["starred", "Starred"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Checkbox checked={fields[key]} onCheckedChange={(checked) => set({ [key]: checked === true })} />
            {label}
          </label>
        ))}
      </div>
      <div className="rounded-md bg-white/[0.04] px-2 py-1.5 font-mono text-[11px] text-muted-foreground" data-selectable>
        {query || "Fill in any field above."}
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => setShowSyntax((v) => !v)}
          className="me-auto flex cursor-pointer items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", showSyntax && "rotate-90")} />
          Search syntax
        </button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setFields(EMPTY)}>
          Clear
        </Button>
        <Button type="submit" size="sm" disabled={!query}>
          Search
        </Button>
      </div>
      {showSyntax ? (
        <ul className="animate-fade-in space-y-1 border-border border-t pt-2 text-muted-foreground text-xs leading-relaxed" data-selectable>
          {QUERY_SYNTAX_HELP.split("\n").map((line) => (
            <li key={line} className={cn(line.startsWith("  ") && "ps-3")}>
              {line.trim()}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
