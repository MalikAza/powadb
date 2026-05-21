import { Command as CommandPrimitive } from "cmdk";
import { Table2 } from "lucide-react";
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
  const sorted = [...tables].sort((a, b) =>
    `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
  );

  return (
    <PopoverContent
      align="end"
      className="w-80 p-0"
      onOpenAutoFocus={(e) => {
        // Let cmdk auto-focus its input rather than the content root.
        e.preventDefault();
      }}
    >
      <CommandPrimitive
        className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground"
        filter={(value, search) => {
          // cmdk lowercases both already; substring match anywhere in the table id.
          return value.includes(search) ? 1 : 0;
        }}
      >
        <CommandInput placeholder="Find table…" autoFocus />
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
