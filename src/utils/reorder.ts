import { byPositionThenName } from "./folderTree";

type Orderable = { id: string; name: string; position: number | null };

/// Compute the ordered id list of a sidebar container after dropping
/// `movedId` at `targetIndex`.
///
/// `containerItems` are the target container's items of the moved kind
/// (connections or folders), in any order; for a same-container drag they
/// include the moved item, for a cross-container drag they don't — it is
/// filtered out then re-inserted either way. Sorting happens here with
/// `byPositionThenName`, which materializes the alphabetical fallback order
/// the first time a container is dragged in: every id gets an explicit
/// position (its index in the returned list) from then on.
export function computeContainerOrder(
  containerItems: Orderable[],
  movedId: string,
  targetIndex: number,
): string[] {
  const rest = containerItems.toSorted(byPositionThenName).filter((i) => i.id !== movedId);
  const index = Math.max(0, Math.min(targetIndex, rest.length));
  const ids = rest.map((i) => i.id);
  ids.splice(index, 0, movedId);
  return ids;
}
