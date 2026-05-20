import ReactMarkdown from "react-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import changelogMd from "../../CHANGELOG.md?raw";

const markdownComponents = {
  h1: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className={cn("mb-2 text-base font-semibold", className)} {...props}>
      {children}
    </h1>
  ),
  h2: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className={cn(
        "mt-5 mb-1 border-b border-border pb-1 text-sm font-semibold first:mt-0",
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className={cn("mt-3 mb-1 text-xs font-semibold text-muted-foreground", className)}
      {...props}
    >
      {children}
    </h3>
  ),
  p: ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className={cn("mb-2 text-xs leading-relaxed text-foreground/90", className)} {...props} />
  ),
  ul: ({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className={cn("mb-2 ml-4 list-disc space-y-1 text-xs", className)} {...props} />
  ),
  li: ({ className, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li className={cn("leading-relaxed text-foreground/90", className)} {...props} />
  ),
  code: ({ className, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <code
      className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[11px]", className)}
      {...props}
    />
  ),
  a: ({ className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      className={cn("text-primary underline-offset-2 hover:underline", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
};

export function ChangelogView({ currentVersion }: { currentVersion: string | null }) {
  return (
    <div className="grid gap-2">
      <ScrollArea className="h-[55vh] rounded-md border border-border bg-muted/20 p-3">
        <ReactMarkdown components={markdownComponents}>{changelogMd}</ReactMarkdown>
      </ScrollArea>
      {currentVersion && (
        <p className="text-[11px] text-muted-foreground">
          You are on <span className="font-mono">v{currentVersion}</span>.
        </p>
      )}
    </div>
  );
}
