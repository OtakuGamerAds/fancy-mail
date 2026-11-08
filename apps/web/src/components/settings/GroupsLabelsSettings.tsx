/** Settings › Groups & labels: create, rename, recolor, reorder and delete. */
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { COLOR_PALETTE } from "@fancy-mail/contracts";
import { CheckIcon, GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ColorDot, IconButton } from "~/components/common";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { plural } from "~/lib/utils";
import { createGroup, createLabel, reorderGroups, reorderLabels, updateGroup, updateLabel } from "~/state/actions";
import { useDirectory } from "~/state/queries";
import { useUi } from "~/state/ui";
import { SettingsSection } from "./layout";

export function GroupsLabelsSettings() {
  const dir = useDirectory();
  const openDialog = useUi((s) => s.openDialog);
  const accountsIn = (groupId: string) => dir.accounts.filter((a) => a.groupId === groupId).length;
  return (
    <>
      <SettingsSection
        title="Groups"
        description="Each group has its own inbox in the sidebar. Deleting a group keeps its accounts."
        action={<NewItemButton label="New group" onCreate={(name) => void createGroup(name)} />}
        plain
      >
        <SortableList
          ids={dir.groups.map((g) => g.id)}
          onReorder={(ids) => void reorderGroups(ids)}
          empty="No groups yet. Groups gather accounts: Banking, Channels, Business, Personal…"
          renderItem={(id) => {
            const group = dir.groupById.get(id)!;
            return (
              <ItemRow
                name={group.name}
                color={group.color}
                detail={plural(accountsIn(group.id), "account")}
                onRename={(name) => void updateGroup(group.id, { name })}
                onColor={(color) => color && void updateGroup(group.id, { color })}
                onDelete={() => openDialog({ type: "delete-group", groupId: group.id })}
              />
            );
          }}
        />
      </SettingsSection>
      <SettingsSection
        title="Labels"
        description="A label is one name across every account. It is mirrored to the server (Gmail labels, IMAP keywords), so your organization survives this app."
        action={<NewItemButton label="New label" onCreate={(name) => void createLabel(name)} />}
        plain
      >
        <SortableList
          ids={dir.labels.map((l) => l.id)}
          onReorder={(ids) => void reorderLabels(ids)}
          empty="No labels yet."
          renderItem={(id) => {
            const label = dir.labelById.get(id)!;
            return (
              <ItemRow
                name={label.name}
                color={label.color}
                allowNoColor
                detail={plural(label.threadCount, "conversation")}
                onRename={(name) => void updateLabel(label.id, { name })}
                onColor={(color) => void updateLabel(label.id, { color })}
                onDelete={() => openDialog({ type: "delete-label", labelId: label.id })}
              />
            );
          }}
        />
      </SettingsSection>
    </>
  );
}

function NewItemButton({ label, onCreate }: { label: string; onCreate(name: string): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon />
        {label}
      </PopoverTrigger>
      <PopoverPopup align="end" padding="compact">
        <form
          className="flex w-64 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onCreate(name.trim());
            setName("");
            setOpen(false);
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name"
            aria-label={`${label} name`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-input/32 px-2.5 text-sm outline-none placeholder:text-placeholder focus:border-ring"
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Create
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function SortableList({
  ids,
  onReorder,
  renderItem,
  empty,
}: {
  ids: string[];
  onReorder(ids: string[]): void;
  renderItem(id: string): ReactNode;
  empty: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (ids.length === 0) {
    return <div className="rounded-xl border border-border/60 border-dashed px-4 py-6 text-center text-muted-foreground text-sm">{empty}</div>;
  }
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from !== -1 && to !== -1) onReorder(arrayMove(ids, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-border/50 [&>*+*]:border-t">
          {ids.map((id) => (
            <SortableRow key={id} id={id}>
              {renderItem(id)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, position: "relative", zIndex: isDragging ? 10 : undefined }}
      className="flex items-center gap-2 bg-card/40 px-3 py-2 sm:px-4"
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label="Move"
        className="-ms-1.5 grid size-6 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-4" />
      </button>
      {children}
    </div>
  );
}

function ItemRow({
  name,
  color,
  detail,
  allowNoColor,
  onRename,
  onColor,
  onDelete,
}: {
  name: string;
  color: string | null;
  detail: string;
  allowNoColor?: boolean;
  onRename(name: string): void;
  onColor(color: string | null): void;
  onDelete(): void;
}) {
  const [value, setValue] = useState(name);
  const [lastName, setLastName] = useState(name);
  if (name !== lastName) {
    setLastName(name);
    setValue(name);
  }
  const commit = () => {
    const next = value.trim();
    if (next && next !== name) onRename(next);
    else setValue(name);
  };
  return (
    <>
      <ColorPicker color={color} onChange={onColor} allowNone={allowNoColor} />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setValue(name);
            event.currentTarget.blur();
          }
        }}
        aria-label="Name"
        className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none hover:bg-white/[0.04] focus:bg-input/32 focus:ring-1 focus:ring-ring"
      />
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{detail}</span>
      <IconButton label="Delete" variant="ghost-destructive" onClick={onDelete}>
        <Trash2Icon />
      </IconButton>
    </>
  );
}

function ColorPicker({ color, onChange, allowNone }: { color: string | null; onChange(color: string | null): void; allowNone?: boolean | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Color"
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-accent"
          />
        }
      >
        <ColorDot color={color} className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact">
        <div className="grid grid-cols-6 gap-1">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className="grid size-7 cursor-pointer place-items-center rounded-md hover:bg-accent"
            >
              <span className="grid size-4.5 place-items-center rounded-full" style={{ background: c }}>
                {color?.toLowerCase() === c ? <CheckIcon className="size-3 text-white" strokeWidth={3} /> : null}
              </span>
            </button>
          ))}
        </div>
        {allowNone ? (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="mt-1 flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
          >
            <ColorDot color={null} />
            No color
          </button>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
