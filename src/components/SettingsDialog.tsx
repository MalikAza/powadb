import { Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { type ThemeMode, useTheme } from "../stores/theme";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SettingsDialog({ open, onOpenChange }: Props) {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Section title="Appearance" description="Light, dark, or follow your system theme.">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as ThemeMode)}
            className="grid grid-cols-3 gap-2"
          >
            <ThemeCard
              value="light"
              current={mode}
              icon={<Sun className="size-5" />}
              label="Light"
            />
            <ThemeCard
              value="dark"
              current={mode}
              icon={<Moon className="size-5" />}
              label="Dark"
            />
            <ThemeCard
              value="system"
              current={mode}
              icon={<Laptop className="size-5" />}
              label="System"
            />
          </RadioGroup>
        </Section>

        <DialogFooter className="mt-2">
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function ThemeCard({
  value,
  current,
  icon,
  label,
}: {
  value: ThemeMode;
  current: ThemeMode;
  icon: React.ReactNode;
  label: string;
}) {
  const selected = current === value;
  const id = `theme-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer flex-col items-center gap-2 rounded-md border p-3 transition-colors",
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
      )}
    >
      <RadioGroupItem id={id} value={value} className="sr-only" />
      <span className={cn(selected ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </label>
  );
}
