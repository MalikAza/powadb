import { useEffect } from "react";
import { runUpdateCheck } from "@/lib/updater";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function UpdateChecker() {
  useEffect(() => {
    runUpdateCheck();
    const id = setInterval(() => runUpdateCheck(), CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return null;
}
