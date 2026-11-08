/**
 * Dragging in the Groups section: groups reorder among themselves; accounts reorder inside a
 * group or move to another one (drop on an account to land before it, on a group's row to
 * land at its end, on "Ungrouped" to leave every group).
 */
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Account, Group } from "@fancy-mail/contracts";
import { useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { AccountAvatar, ColorDot } from "~/components/common";
import { reorderAccounts, reorderGroups } from "~/state/actions";
import { sidebarRowClass } from "./SidebarRow";

export interface DragHandle {
  ref: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes | Record<string, never>;
  listeners: DraggableSyntheticListeners | Record<string, never>;
  style?: CSSProperties;
}

type ItemData = { type: "group"; groupKey: string } | { type: "account"; groupKey: string | null } | { type: "container"; groupKey: string | null };

export function SortableItem({ id, data, children }: { id: string; data: ItemData; children: (handle: DragHandle) => ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id, data });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        position: "relative",
        zIndex: isDragging ? 10 : undefined,
        opacity: isDragging ? 0.4 : undefined,
      }}
    >
      {children({ ref: setActivatorNodeRef, attributes: { ...attributes, tabIndex: 0 }, listeners })}
    </div>
  );
}

export function AccountsSortable({ ids, children }: { ids: string[]; children: ReactNode }) {
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

function Droppable({ id, children }: { id: string; children: (isOver: boolean) => ReactNode }) {
  const { setNodeRef } = useDroppable({ id, data: { type: "container", groupKey: null } satisfies ItemData });
  return <div ref={setNodeRef}>{children(false)}</div>;
}

export function GroupsDnd({
  groups,
  accountsByGroup,
  renderGroup,
  renderUngrouped,
}: {
  groups: Group[];
  accountsByGroup: Map<string | null, Account[]>;
  renderGroup(group: Group, accounts: Account[], handle: DragHandle, dropTarget: boolean): ReactNode;
  renderUngrouped(handleFor: undefined, dropTarget: boolean): ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  /** The group an account is being dragged into ("" for ungrouped), while it differs from its own. */
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const onDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const groupOf = (data: ItemData | undefined): string | null | undefined => {
    if (!data) return undefined;
    return data.groupKey;
  };

  const onDragOver = (event: DragOverEvent) => {
    const active = event.active.data.current as ItemData | undefined;
    const over = event.over?.data.current as ItemData | undefined;
    if (active?.type !== "account" || !over) {
      setDropGroup(null);
      return;
    }
    const target = groupOf(over);
    setDropGroup(target === active.groupKey || target === undefined ? null : (target ?? ""));
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDropGroup(null);
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeData = active.data.current as ItemData | undefined;
    const overData = over.data.current as ItemData | undefined;
    if (!activeData || !overData) return;

    if (activeData.type === "group") {
      const ids = groups.map((g) => g.id);
      const from = ids.indexOf(activeData.groupKey);
      const toKey = overData.groupKey;
      const to = toKey ? ids.indexOf(toKey) : -1;
      if (from === -1 || to === -1 || from === to) return;
      void reorderGroups(arrayMove(ids, from, to));
      return;
    }

    if (activeData.type === "account") {
      const accountId = String(active.id).replace(/^account:/, "");
      const targetGroup = overData.groupKey ?? null;
      const sourceGroup = activeData.groupKey;
      const targetAccounts = (accountsByGroup.get(targetGroup) ?? []).map((a) => a.id);
      if (targetGroup === sourceGroup && overData.type === "account") {
        const overId = String(over.id).replace(/^account:/, "");
        const from = targetAccounts.indexOf(accountId);
        const to = targetAccounts.indexOf(overId);
        if (from === -1 || to === -1 || from === to) return;
        void reorderAccounts(arrayMove(targetAccounts, from, to), targetGroup);
        return;
      }
      const without = targetAccounts.filter((id) => id !== accountId);
      let index = without.length;
      if (overData.type === "account") {
        const overId = String(over.id).replace(/^account:/, "");
        const at = without.indexOf(overId);
        if (at !== -1) index = at;
      }
      without.splice(index, 0, accountId);
      void reorderAccounts(without, targetGroup);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      onDragCancel={() => {
        setDropGroup(null);
        setActiveId(null);
      }}
    >
      <SortableContext items={groups.map((g) => `group:${g.id}`)} strategy={verticalListSortingStrategy}>
        {groups.map((group) => (
          <SortableItem key={group.id} id={`group:${group.id}`} data={{ type: "group", groupKey: group.id }}>
            {(handle) => renderGroup(group, accountsByGroup.get(group.id) ?? [], handle, dropGroup === group.id)}
          </SortableItem>
        ))}
      </SortableContext>
      <Droppable id="container:none">{() => renderUngrouped(undefined, dropGroup === "")}</Droppable>
      {createPortal(
        <DragOverlay dropAnimation={null}>{activeId ? <DragPreview id={activeId} groups={groups} accountsByGroup={accountsByGroup} /> : null}</DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/** What follows the pointer while dragging: the row itself, lifted. */
function DragPreview({ id, groups, accountsByGroup }: { id: string; groups: Group[]; accountsByGroup: Map<string | null, Account[]> }) {
  const shell = `${sidebarRowClass} pointer-events-none cursor-grabbing bg-popover text-sidebar-foreground shadow-lg shadow-black/40 ring-1 ring-border`;
  if (id.startsWith("group:")) {
    const group = groups.find((g) => `group:${g.id}` === id);
    if (!group) return null;
    return (
      <div className={shell} data-app-sidebar>
        <ColorDot color={group.color} className="ms-6" />
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
      </div>
    );
  }
  const account = [...accountsByGroup.values()].flat().find((a) => `account:${a.id}` === id);
  if (!account) return null;
  return (
    <div className={shell}>
      <AccountAvatar account={account} />
      <span className="min-w-0 flex-1 truncate">{account.displayName || account.email}</span>
    </div>
  );
}
