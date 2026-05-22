import { Command as CommandPrimitive } from "cmdk";
import { Table2 } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";
import type { DiagramTable } from "./types";

type Props = {
  tables: DiagramTable[];
  onSelect: (id: string) => void;
  onClose: () => void;
};

export function TableSearchPopover({ tables, onSelect, onClose }: Props) {
  const sorted = tables.toSorted((a, b) =>
    `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLInputElement>('[data-slot="command-input"]')?.focus();
  }, []);

  return (
    <PopoverContent
      align="end"
      className="w-80 p-0"
      onOpenAutoFocus={(e) => {
        // Skip Radix's default content-root focus; the effect targets the input directly.
        e.preventDefault();
      }}
    >
      <CommandPrimitive
        ref={rootRef}
        className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground"
        filter={(value, search) => {
          // cmdk lowercases both already; substring match anywhere in the table id.
          return value.includes(search) ? 1 : 0;
        }}
      >
        <CommandInput placeholder="Find table…" />
        <CommandList>
          <CommandEmpty>No table matches.</CommandEmpty>
          <CommandGroup>
            {sorted.map((t) => {
              const id = `${t.schema}.${t.name}`;
              return (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => {
                    onSelect(id);
                    onClose();
                  }}
                >
                  <Table2 className="size-3.5" />
                  <span className="truncate">
                    <span className="text-muted-foreground">{t.schema}.</span>
                    {t.name}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandPrimitive>
    </PopoverContent>
  );
}
